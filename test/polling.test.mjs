// Poller behavior: long polling loop, update_id de-duplication, offset
// persistence, 429 retry_after, network backoff, graceful 409 stop,
// disabled mode, and needs-configuration.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramFetchStub,
  installPlugin,
  makeMessage,
  makeUpdate,
  runUntil,
  TEST_SETTINGS,
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
