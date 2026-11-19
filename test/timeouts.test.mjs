// Per-request client-side timeouts + shutdown wiring (V4-hardening):
// a request aimed at a dead route must fail with a network error within the
// timeout (instead of hanging forever and wedging the poller's stop window),
// stopping the service must cut an in-flight getUpdates, and a broadcast with
// one hanging recipient must finish bounded with that recipient failed.

import Database from "better-sqlite3";
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramFetchStub, installPlugin, waitFor } from "./helpers.mjs";

const { createTelegramApi, createDelivery, TelegramNetworkError, MIGRATIONS } =
  await import("../dist/server.js");

/** fetch that never answers unless the request's AbortSignal fires. */
function hangingFetchImpl(onRequest) {
  return (url, opts) => {
    onRequest?.(url, opts);
    return new Promise((resolve, reject) => {
      opts?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  };
}

test("getUpdates times out as a network error when the API never answers", async () => {
  const api = createTelegramApi({
    fetchImpl: hangingFetchImpl(),
    getUpdatesTimeoutMs: 250,
  });
  const started = Date.now();
  await assert.rejects(
    () => api.getUpdates("token", { offset: 0 }),
    (cause) => {
      assert.ok(
        cause instanceof TelegramNetworkError,
        `expected TelegramNetworkError, got: ${cause?.name ?? cause}`,
      );
      assert.match(cause.message, /timed out after 250ms/);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 200, "must wait for the timeout, not fail instantly");
});

test("sendMessage times out with the default request timeout", async () => {
  const api = createTelegramApi({ fetchImpl: hangingFetchImpl(), defaultTimeoutMs: 250 });
  await assert.rejects(
    () => api.sendMessage("token", 123, "hi"),
    (cause) => {
      assert.ok(cause instanceof TelegramNetworkError);
      assert.match(cause.message, /timed out after 250ms/);
      return true;
    },
  );
});

test("stopping the service aborts the in-flight getUpdates; the poller stops promptly", async () => {
  const stub = createTelegramFetchStub();
  // getUpdates hangs until the request is aborted — the only way out is the
  // shutdown signal (no timer of the fake's own).
  let getUpdatesInFlight = false;
  const original = stub.fetchImpl;
  stub.fetchImpl = (url, opts) => {
    if (String(url).includes("/getUpdates")) {
      getUpdatesInFlight = true;
      return new Promise((resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    }
    return original(url, opts);
  };
  const { harness, cleanup } = await installPlugin({ stub });
  try {
    const service = harness.behavior.runService("telegram-poller");
    try {
      await waitFor(() => getUpdatesInFlight, 10_000);
      const started = Date.now();
      service.controller.abort();
      const stopped = await Promise.race([
        service.done.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      const took = Date.now() - started;
      assert.ok(stopped, "the service must settle after the abort");
      assert.ok(took < 4_000, `poller must stop promptly after abort, took ${took}ms`);
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await cleanup();
  }
});

test("broadcast with one hanging recipient: that chat fails on the timeout, others delivered, bounded time", async () => {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  db.prepare(`INSERT INTO channels (id, name) VALUES ('monitoring', 'Monitoring')`).run();
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, 'monitoring', NULL)`,
  ).run(401);
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, 'monitoring', NULL)`,
  ).run(402);
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, 'monitoring', NULL)`,
  ).run(403);

  const HANG_CHAT = 402;
  const delivered = [];
  const fetchImpl = (url, opts) => {
    if (JSON.parse(opts.body).chat_id === HANG_CHAT) {
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    }
    delivered.push(JSON.parse(opts.body).chat_id);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  };

  const failures = new Map();
  const api = createTelegramApi({ fetchImpl, defaultTimeoutMs: 300 });
  const delivery = createDelivery({
    db,
    api,
    getToken: async () => "token",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    failures: {
      get: async (chatId) => failures.get(chatId) ?? 0,
      inc: async (chatId) => {
        const next = (failures.get(chatId) ?? 0) + 1;
        failures.set(chatId, next);
        return next;
      },
      reset: async (chatId) => {
        failures.delete(chatId);
      },
    },
  });

  const started = Date.now();
  const result = await delivery.broadcast({
    title: "t",
    body: "b",
    channels: ["monitoring"],
  });
  const took = Date.now() - started;

  assert.equal(result.sent, 2, "the two healthy chats were delivered");
  assert.equal(result.failed, 1, "the hanging chat counted as failed");
  assert.deepEqual(delivered.sort((a, b) => a - b), [401, 403]);
  // Bounded: the hung request is cut by its own 300ms client timeout, so the
  // whole broadcast finishes well before the old unbounded behavior.
  assert.ok(took >= 250, `must wait for the per-request timeout (${took}ms)`);
  assert.ok(took < 3_000, `broadcast must be bounded, took ${took}ms`);
  // A pure network timeout must not auto-unsubscribe the chat.
  assert.deepEqual(result.autoUnsubscribed, []);
  db.close();
});
