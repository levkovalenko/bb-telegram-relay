// Poller behavior: long polling loop, update_id de-duplication, offset
// persistence, 429 retry_after, network backoff, graceful 409 stop,
// disabled mode, needs-configuration, stale-batch backoff (an offset the
// API can never reach must not hot-loop), and the per-bot offset cursor
// (reset to 0 when the bot behind the token changes).

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramFetchStub,
  installPlugin,
  makeMessage,
  makeUpdate,
  runUntil,
  TEST_SETTINGS,
  waitFor,
} from "./helpers.mjs";

test("polls getUpdates, dedups update_id, persists the acked offset", async () => {
  const stub = createTelegramFetchStub();
  const { harness, bb, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(101, { message: makeMessage(111, "/start") }),
        makeUpdate(101, { message: makeMessage(111, "/start") }), // duplicate
        makeUpdate(102, { message: makeMessage(222, "/help") }),
      ],
    });
    await runUntil(
      harness,
      stub,
      () => stub.state.sentMessages.length >= 2,
    );

    // /start was handled exactly once despite the duplicated update_id.
    const welcome = stub.state.sentMessages.filter(
      (message) =>
        message.chatId === 111 &&
        /subscribed|подписался/.test(message.text),
    );
    assert.equal(welcome.length, 1);
    // /help was handled once too.
    assert.equal(
      stub.state.sentMessages.filter((message) => message.chatId === 222).length,
      1,
    );
    // The offset advanced past the last update and was persisted to KV.
    assert.equal(await bb.storage.kv.get("polling-offset"), 103);
    // getUpdates kept the poll timeout from settings (1s in TEST_SETTINGS).
    const getUpdatesCalls = stub.state.calls.filter(
      (call) => call.method === "getUpdates",
    );
    assert.ok(getUpdatesCalls.length >= 1);
    assert.equal(getUpdatesCalls[0].params.timeout, 1);
    assert.equal(getUpdatesCalls[0].params.offset, 0);
    // The second call (if it happened) resumes from the acked offset.
    if (getUpdatesCalls.length >= 2) {
      assert.equal(getUpdatesCalls[1].params.offset, 103);
    }
  } finally {
    await cleanup();
  }
});

test("waits retry_after on 429, then keeps polling", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({ status: 429, retryAfter: 1 });
    stub.state.getUpdatesQueue.push({
      updates: [makeUpdate(7, { message: makeMessage(111, "/start") })],
    });
    const started = Date.now();
    await runUntil(
      harness,
      stub,
      // True once the batch after the 429 was processed AND the next poll
      // resumed from the acked offset — no race at the stop point.
      () =>
        stub.state.sentMessages.length >= 1 &&
        stub.state.calls.some(
          (call) => call.method === "getUpdates" && call.params.offset === 8,
        ),
      10_000,
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= 1000,
      `expected the poller to wait >= 1s for retry_after, got ${elapsed}ms`,
    );
  } finally {
    await cleanup();
  }
});

test("survives a network error with backoff and recovers", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({ error: "network" });
    stub.state.getUpdatesQueue.push({
      updates: [makeUpdate(11, { message: makeMessage(111, "/start") })],
    });
    await runUntil(
      harness,
      stub,
      () =>
        stub.state.sentMessages.length >= 1 &&
        stub.state.calls.filter((call) => call.method === "getUpdates").length >= 2,
      10_000,
    );
  } finally {
    await cleanup();
  }
});

test("stops gracefully on 409 Conflict and reports the conflict state", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({
      status: 409,
      description: "Conflict: terminated by other getUpdates request",
    });
    const service = harness.behavior.runService("telegram-poller");
    // The service must RESOLVE (graceful stop), not reject.
    await service.done;

    const status = await harness.behavior.callRpc("status", null);
    assert.equal(status.state, "conflict");
    assert.match(status.lastError, /409/);
    const logged = harness.inspection.logEntries.some(
      (entry) => /409/.test(entry.message ?? ""),
    );
    assert.ok(logged, "the 409 stop must be logged");
  } finally {
    await cleanup();
  }
});

test("stays idle and skips getUpdates while disabled", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({
    stub,
    settings: { ...TEST_SETTINGS, enabled: false },
  });
  try {
    const service = harness.behavior.runService("telegram-poller");
    try {
      let state = null;
      for (let i = 0; i < 100 && state !== "disabled"; i++) {
        state = (await harness.behavior.callRpc("status", null)).state;
        if (state !== "disabled") await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(state, "disabled");
      // Give any (incorrect) getUpdates call a moment to happen.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        stub.state.calls.filter((call) => call.method === "getUpdates").length,
        0,
        "no getUpdates while disabled",
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

test("reports needs-configuration without a bot token (no crash loop)", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({
    stub,
    // No botToken: the plugin must report needs-configuration, not crash.
    settings: {
      ownerChatId: TEST_SETTINGS.ownerChatId,
      enabled: TEST_SETTINGS.enabled,
      pollTimeout: TEST_SETTINGS.pollTimeout,
    },
  });
  try {
    assert.ok(
      harness.inspection.needsConfigurationMessages.length >= 1,
      "factory must call status.needsConfiguration",
    );
    const status = await harness.behavior.callRpc("status", null);
    assert.equal(status.configured, false);
    // Starting the service records the condition and resolves (no throw).
    const service = harness.behavior.runService("telegram-poller");
    await service.done;
    assert.equal(
      stub.state.calls.filter((call) => call.method === "getUpdates").length,
      0,
    );
  } finally {
    await cleanup();
  }
});

// --- Stale batches: the API re-delivering updates below the offset ---------

test("stale batches (offset stuck) back off 1s/2s/4s instead of hot-looping", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    // Same bot, but the persisted offset sits beyond the bot's update
    // sequence: the API keeps re-delivering its last (below-offset) update.
    await bb.storage.kv.set("polling-offset", 500);
    await bb.storage.kv.set("polling-bot-id", stub.state.me.id);
    const staleBatch = () => ({
      updates: [makeUpdate(100, { message: makeMessage(111, "/start") })],
    });
    stub.state.getUpdatesQueue.push(staleBatch(), staleBatch(), staleBatch(), staleBatch());

    const service = harness.behavior.runService("telegram-poller");
    try {
      const getUpdatesCalls = () =>
        stub.state.calls.filter((call) => call.method === "getUpdates");
      await waitFor(() => getUpdatesCalls().length >= 4, 15_000);
      const [a, b, c, d] = getUpdatesCalls().map((call) => call.at);
      assert.ok(b - a >= 950, `first stale pause ~1s, got ${b - a}ms`);
      assert.ok(c - b >= 1900, `second stale pause ~2s, got ${c - b}ms`);
      assert.ok(d - c >= 3800, `third stale pause ~4s, got ${d - c}ms`);
      // The stuck update was never dispatched and the offset did not move.
      assert.equal(stub.state.sentMessages.length, 0, "no dispatch below offset");
      assert.equal(await bb.storage.kv.get("polling-offset"), 500);
      // One warn on the first stale batch, only debug afterwards.
      const warns = harness.inspection.logEntries.filter(
        (entry) =>
          entry.level === "warn" &&
          /keeps returning updates below offset/.test(entry.message),
      );
      assert.equal(warns.length, 1, "one warn, then debug only");
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

test("stale batch then a new update: delivered and backoff reset", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    await bb.storage.kv.set("polling-offset", 500);
    await bb.storage.kv.set("polling-bot-id", stub.state.me.id);
    stub.state.getUpdatesQueue.push({
      updates: [makeUpdate(100, { message: makeMessage(111, "/start") })],
    });
    stub.state.getUpdatesQueue.push({
      updates: [makeUpdate(501, { message: makeMessage(222, "/help") })],
    });

    const service = harness.behavior.runService("telegram-poller");
    try {
      const getUpdatesCalls = () =>
        stub.state.calls.filter((call) => call.method === "getUpdates");
      // Wait for the delivered update AND the next (immediate) poll.
      await waitFor(
        () =>
          getUpdatesCalls().length >= 3 &&
          stub.state.sentMessages.some((message) => message.chatId === 222),
        15_000,
      );
      const calls = getUpdatesCalls();
      assert.ok(
        calls[1].at - calls[0].at >= 950,
        `expected ~1s pause after the stale batch, got ${calls[1].at - calls[0].at}ms`,
      );
      assert.ok(
        calls[2].at - calls[1].at < 900,
        `backoff should be reset after progress, got ${calls[2].at - calls[1].at}ms`,
      );
      assert.equal(await bb.storage.kv.get("polling-offset"), 502);
      assert.equal(
        stub.state.sentMessages.filter((message) => message.chatId === 111).length,
        0,
        "the below-offset update was never dispatched",
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

test("empty batches do not trigger the stale backoff", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    await bb.storage.kv.set("polling-offset", 500);
    await bb.storage.kv.set("polling-bot-id", stub.state.me.id);
    stub.state.getUpdatesQueue.push({}, {}, {});

    const service = harness.behavior.runService("telegram-poller");
    try {
      const getUpdatesCalls = () =>
        stub.state.calls.filter((call) => call.method === "getUpdates");
      await waitFor(() => getUpdatesCalls().length >= 3, 5_000);
      const [a, b, c] = getUpdatesCalls().map((call) => call.at);
      assert.ok(b - a < 900, `no pause after an empty batch, got ${b - a}ms`);
      assert.ok(c - b < 900, `no pause after an empty batch, got ${c - b}ms`);
      assert.ok(
        !harness.inspection.logEntries.some(
          (entry) => entry.level === "warn" && /backing off/.test(entry.message),
        ),
        "no stale-backoff warn",
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

// --- Per-bot offset cursor --------------------------------------------------

test("bot change (getMe id != stored) resets the offset to 0 and re-acks safely", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    // A persisted cursor that belongs to a different bot than getMe returns.
    await bb.storage.kv.set("polling-offset", 500);
    await bb.storage.kv.set("polling-bot-id", 111);
    // The new bot's pending update: /start from a chat already subscribed —
    // re-dispatching it must not duplicate the subscription.
    const db = bb.storage.database();
    db.prepare("INSERT INTO channels (id, name, is_default) VALUES ('general', 'General', 1)").run();
    db.prepare("INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (777, 'general', 'pre')").run();
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(1, {
          message: makeMessage(777, "/start", {
            id: 777,
            first_name: "P",
            username: "pre",
            language_code: "en",
          }),
        }),
      ],
    });

    const service = harness.behavior.runService("telegram-poller");
    try {
      await waitFor(
        () => stub.state.sentMessages.some((message) => message.chatId === 777),
        10_000,
      );
      const calls = stub.state.calls.filter((call) => call.method === "getUpdates");
      assert.equal(calls[0].params.offset, 0, "fresh sequence after the bot change");
      assert.ok(
        stub.state.calls.some((call) => call.method === "getMe"),
        "identity verified via getMe",
      );
      assert.equal(
        await bb.storage.kv.get("polling-bot-id"),
        stub.state.me.id,
        "KV identity updated to the new bot",
      );
      assert.equal(await bb.storage.kv.get("polling-offset"), 2, "pending update acked");
      assert.equal(
        db.prepare(
          "SELECT COUNT(*) AS n FROM subscriptions WHERE chat_id = 777 AND channel_id = 'general'",
        ).get().n,
        1,
        "re-dispatched /start did not duplicate the subscription",
      );
      assert.ok(
        harness.inspection.logEntries.some(
          (entry) => entry.level === "info" && /offset reset to 0/.test(entry.message),
        ),
        "the reset is logged",
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

test("same bot (getMe id == stored) keeps the persisted offset", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    await bb.storage.kv.set("polling-offset", 500);
    await bb.storage.kv.set("polling-bot-id", stub.state.me.id);
    stub.state.getUpdatesQueue.push({}, {});

    const service = harness.behavior.runService("telegram-poller");
    try {
      const getUpdatesCalls = () =>
        stub.state.calls.filter((call) => call.method === "getUpdates");
      await waitFor(() => getUpdatesCalls().length >= 2, 5_000);
      const calls = getUpdatesCalls();
      assert.equal(calls[0].params.offset, 500, "persisted offset reused");
      assert.equal(calls[1].params.offset, 500);
      assert.equal(await bb.storage.kv.get("polling-bot-id"), stub.state.me.id);
      assert.ok(
        !harness.inspection.logEntries.some(
          (entry) => /offset reset to 0/.test(entry.message),
        ),
        "no offset reset for the same bot",
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});
