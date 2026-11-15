// Broadcast delivery (M2): fan-out to subscribers, per-recipient isolation,
// delivery_log (metadata only, no bodies), auto-unsubscribe after 3
// consecutive failures with a success-reset, 429 retry_after, Markdown
// plain-fallback, pacing queue, and the CLI surface — all driven through
// the real plugin (built dist/server.js) with the Telegram API fetch-stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramFetchStub,
  installPlugin,
} from "./helpers.mjs";

function seedChannel(db, id, name = id) {
  db.prepare(`INSERT INTO channels (id, name) VALUES (?, ?)`).run(id, name);
}

function seedSubscriber(db, chatId, channelId, username = null) {
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, ?, ?)`,
  ).run(chatId, channelId, username);
}

test("broadcast to 3 subscribers: one 403 -> sent=2 failed=1; log row is metadata only", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedSubscriber(db, 101, "monitoring", "alice");
    seedSubscriber(db, 102, "monitoring", "bob");
    seedSubscriber(db, 103, "monitoring", "carol");
    stub.state.sendMessageRules.push({
      chatId: 102,
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    });

    const result = await harness.behavior.callRpc("broadcast", {
      title: "Deploy finished",
      body: "build 42 is out *now*",
      channels: ["monitoring"],
      level: "info",
    });
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 1);
    assert.equal(typeof result.logId, "number");

    // The failed recipient is isolated: the others still got the message.
    const delivered = stub.state.sentMessages
      .map((m) => m.chatId)
      .sort((a, b) => a - b);
    assert.deepEqual(delivered, [101, 103]);

    // delivery_log row: metadata only.
    const row = db.prepare(`SELECT * FROM delivery_log WHERE id = ?`).get(result.logId);
    assert.equal(row.channel, "monitoring");
    assert.equal(row.title, "Deploy finished");
    assert.equal(row.level, "info");
    assert.equal(row.sent, 2);
    assert.equal(row.failed, 1);
    const errors = JSON.parse(row.errors);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].chat_id, 102);
    assert.equal(errors[0].code, 403);
    assert.match(errors[0].description, /blocked by the user/);
    // Privacy: no message body anywhere in the journal row.
    assert.ok(!JSON.stringify(row).includes("build 42 is out"));

    // listDeliveries RPC (M3 journal input) returns the row with parsed errors.
    const deliveries = await harness.behavior.callRpc("listDeliveries", { limit: 10 });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].id, result.logId);
    assert.deepEqual(deliveries[0].errors, errors);
    assert.equal(deliveries[0].title, "Deploy finished");
  } finally {
    await cleanup();
  }
});

test("3 consecutive failures on one chat -> auto-unsubscribed; later broadcasts skip it", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedSubscriber(db, 201, "monitoring", "dead");
    seedSubscriber(db, 202, "monitoring", "alive");
    stub.state.sendMessageRules.push({
      chatId: 201,
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    });

    const broadcast = () =>
      harness.behavior.callRpc("broadcast", {
        title: "t",
        body: "b",
        channels: ["monitoring"],
      });
    const subsOf = (chatId) =>
      db.prepare(`SELECT COUNT(*) AS c FROM subscriptions WHERE chat_id = ?`).get(chatId).c;

    const r1 = await broadcast();
    assert.deepEqual([r1.sent, r1.failed], [1, 1]);
    assert.equal(subsOf(201), 1, "still subscribed after failure 1");
    const r2 = await broadcast();
    assert.deepEqual([r2.sent, r2.failed], [1, 1]);
    assert.equal(subsOf(201), 1, "still subscribed after failure 2");
    const r3 = await broadcast();
    assert.deepEqual([r3.sent, r3.failed], [1, 1]);
    assert.equal(subsOf(201), 0, "auto-unsubscribed after the third consecutive failure");
    const r4 = await broadcast();
    assert.deepEqual([r4.sent, r4.failed], [1, 0], "fourth broadcast: no attempt to the dead chat");
    // Exactly one message per broadcast for the surviving chat, four total.
    assert.equal(stub.state.sentMessages.length, 4);
    assert.ok(stub.state.sentMessages.every((m) => m.chatId === 202));
    // The auto-unsubscribe was logged (metadata only).
    const logged = harness.inspection.logEntries.some((e) =>
      /auto-unsubscribed/.test(e.message ?? ""),
    );
    assert.ok(logged, "the auto-unsubscribe must be logged");
  } finally {
    await cleanup();
  }
});

test("a successful delivery resets the consecutive-failure counter", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedSubscriber(db, 301, "monitoring", "flaky");
    // Two 403s, then success (flaky chat recovers), then two more 403s.
    stub.state.sendMessageRules.push({
      chatId: 301,
      status: 403,
      description: "Forbidden: bot was blocked by the user",
      times: 2,
    });

    const broadcast = () =>
      harness.behavior.callRpc("broadcast", {
        title: "t",
        body: "b",
        channels: ["monitoring"],
      });
    const subsOf = () =>
      db.prepare(`SELECT COUNT(*) AS c FROM subscriptions WHERE chat_id = 301`).get().c;

    const r1 = await broadcast();
    assert.equal(r1.failed, 1); // streak: 1
    const r2 = await broadcast();
    assert.equal(r2.failed, 1); // streak: 2
    const r3 = await broadcast();
    assert.equal(r3.sent, 1, "success in between"); // streak resets to 0
    stub.state.sendMessageRules.push({
      chatId: 301,
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    const r4 = await broadcast();
    assert.equal(r4.failed, 1); // streak: 1 again (not 3)
    const r5 = await broadcast();
    assert.equal(r5.failed, 1); // streak: 2
    assert.equal(subsOf(), 1, "streak was reset by the success — no auto-unsubscribe");
  } finally {
    await cleanup();
  }
});

test("429 with retry_after: waits the given time, retries, delivers", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedSubscriber(db, 401, "monitoring", "rate");
    stub.state.sendMessageRules.push({ chatId: 401, status: 429, retryAfter: 1, times: 1 });

    const started = Date.now();
    const result = await harness.behavior.callRpc("broadcast", {
      title: "t",
      body: "b",
      channels: ["monitoring"],
    });
    const elapsed = Date.now() - started;
    assert.deepEqual([result.sent, result.failed], [1, 0], "delivered after the retry");
    assert.ok(elapsed >= 1000, `expected to wait >= 1s for retry_after, got ${elapsed}ms`);
    const attempts = stub.state.calls.filter(
      (c) => c.method === "sendMessage" && c.params.chat_id === 401,
    );
    assert.equal(attempts.length, 2, "429 was retried exactly once here");
  } finally {
    await cleanup();
  }
});

test("Markdown 400 parse error -> plain retry, still counts as delivered", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedSubscriber(db, 501, "monitoring", "markdown");
    stub.state.sendMessageRules.push({
      chatId: 501,
      status: 400,
      description: "Bad Request: can't parse entities: Tag must not be empty",
      times: 1,
    });

    const result = await harness.behavior.callRpc("broadcast", {
      title: "t",
      body: "b",
      channels: ["monitoring"],
    });
    assert.deepEqual([result.sent, result.failed], [1, 0], "plain fallback is delivered");

    const attempts = stub.state.calls.filter(
      (c) => c.method === "sendMessage" && c.params.chat_id === 501,
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].params.parse_mode, "Markdown");
    assert.equal(attempts[1].params.parse_mode, undefined, "retry went out as plain");
    const plain = stub.state.sentMessages.find((m) => m.chatId === 501);
    assert.ok(plain, "the plain message was recorded as sent");
    assert.equal(plain.parseMode, null);
  } finally {
    await cleanup();
  }
});

test("pacing: ~30 msg/s ceiling across a large fan-out", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    for (let chatId = 701; chatId <= 745; chatId += 1) {
      seedSubscriber(db, chatId, "monitoring");
    }

    const started = Date.now();
    const result = await harness.behavior.callRpc("broadcast", {
      title: "t",
      body: "b",
      channels: ["monitoring"],
    });
    const elapsed = Date.now() - started;
    assert.deepEqual([result.sent, result.failed], [45, 0]);
    // 45 messages at <= ~30/s take at least ~1.5s (first send is immediate).
    assert.ok(elapsed >= 1400, `expected >= 1.4s pacing for 45 sends, got ${elapsed}ms`);
  } finally {
    await cleanup();
  }
});

test("CLI broadcast: same delivery path; prints sent/failed/logId", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedChannel(db, "incidents", "Incidents");
    seedSubscriber(db, 601, "monitoring");
    seedSubscriber(db, 602, "incidents");
    seedSubscriber(db, 603, "monitoring");

    const result = await harness.behavior.runCli([
      "broadcast",
      "--title",
      "Site degraded",
      "--body",
      "p99 up",
      "--channels",
      "monitoring,incidents",
      "--level",
      "warning",
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /sent: 3/);
    assert.match(result.stdout, /failed: 0/);
    assert.match(result.stdout, /logId: 1/);
    // One message per unique chat across both channels.
    assert.equal(stub.state.sentMessages.length, 3);
    const row = db.prepare(`SELECT * FROM delivery_log WHERE id = 1`).get();
    assert.equal(row.channel, "monitoring,incidents");
    assert.equal(row.level, "warning");
    assert.equal(row.title, "Site degraded");

    // The deliveries subcommand lists the journal (metadata only).
    const list = await harness.behavior.runCli(["deliveries", "10"]);
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout, /#1 .*monitoring,incidents sent=3 failed=0 Site degraded/);
  } finally {
    await cleanup();
  }
});

test("CLI broadcast rejects missing flags and unknown channels", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    seedChannel(bb.storage.database(), "monitoring", "Monitoring");
    const missing = await harness.behavior.runCli(["broadcast", "--title", "x"]);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /requires --title/);
    const badLevel = await harness.behavior.runCli([
      "broadcast",
      "--title",
      "x",
      "--body",
      "b",
      "--channels",
      "monitoring",
      "--level",
      "urgent",
    ]);
    assert.equal(badLevel.exitCode, 1);
    assert.match(badLevel.stderr, /--level must be one of/);
    const unknown = await harness.behavior.runCli([
      "broadcast",
      "--title",
      "x",
      "--body",
      "b",
      "--channels",
      "nope",
    ]);
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.stderr, /unknown channel/);
    // Nothing was sent.
    assert.equal(stub.state.sentMessages.length, 0);
    assert.equal(
      bb.storage.database().prepare(`SELECT COUNT(*) AS c FROM delivery_log`).get().c,
      0,
      "a rejected broadcast leaves no journal row",
    );
  } finally {
    await cleanup();
  }
});
