// Shared test helpers: a Telegram API fetch stub and a fake-host installer
// for the built server bundle (dist/server.js).
//
// The stub replaces globalThis.fetch for api.telegram.org traffic: tests
// queue getUpdates batches (or errors) and inspect the outbound sendMessage /
// answerCallbackQuery / editMessageText calls. No network, no real token.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a fetch stub for the Telegram Bot API.
 *
 * Queue entries (consumed one per getUpdates call, in order):
 *   { updates: [...] }           -> 200 { ok: true, result: updates }
 *   { error: "network" }         -> the fetch rejects (connection failure)
 *   { status: 409 }              -> 409 Conflict (another consumer)
 *   { status: 429, retryAfter }  -> 429 with parameters.retry_after
 * An empty queue answers 200 with no updates (like a quiet long poll).
 *
 * sendMessageRules: per-chat scripted answers for outbound sendMessage
 * (broadcast tests): { chatId, status, description?, retryAfter?, times? } —
 * matched by chat_id, one-shot unless `times` is given. Unmatched chats
 * answer 200 as before.
 */
export function createTelegramFetchStub() {
  const state = {
    calls: [], // { method, params } for every request
    getUpdatesQueue: [],
    getUpdatesDelayMs: 5,
    sentMessages: [], // { chatId, text, replyMarkup }
    answeredCallbacks: [], // { id, text }
    editedMessages: [], // { chatId, messageId, text, replyMarkup }
    sendMessageRules: [], // { chatId, status, description?, retryAfter?, times? }
    me: {
      id: 905000001,
      is_bot: true,
      first_name: "TestRelay",
      username: "test_relay_bot",
    },
  };

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const method = parsed.pathname.split("/").filter(Boolean).pop();
    const params = init?.body ? JSON.parse(init.body) : {};
    state.calls.push({ method, params });

    switch (method) {
      case "getUpdates": {
        if (state.getUpdatesDelayMs > 0) await sleep(state.getUpdatesDelayMs);
        const next = state.getUpdatesQueue.shift();
        if (next === undefined) return jsonResponse(200, { ok: true, result: [] });
        if (next.error === "network") throw new TypeError("fetch failed (stub)");
        if (next.status) {
          return jsonResponse(next.status, {
            ok: false,
            description: next.description ?? `stub ${next.status}`,
            ...(next.retryAfter !== undefined
              ? { parameters: { retry_after: next.retryAfter } }
              : {}),
          });
        }
        return jsonResponse(200, { ok: true, result: next.updates ?? [] });
      }
      case "sendMessage": {
        const rule = state.sendMessageRules.find(
          (r) => r.chatId === params.chat_id && (r.times === undefined || r.times > 0),
        );
        if (rule) {
          if (rule.times !== undefined) rule.times -= 1;
          return jsonResponse(rule.status, {
            ok: false,
            description: rule.description ?? `stub ${rule.status}`,
            ...(rule.retryAfter !== undefined
              ? { parameters: { retry_after: rule.retryAfter } }
              : {}),
          });
        }
        state.sentMessages.push({
          chatId: params.chat_id,
          text: params.text,
          replyMarkup: params.reply_markup ?? null,
          parseMode: params.parse_mode ?? null,
        });
        return jsonResponse(200, {
          ok: true,
          result: { message_id: 1000 + state.sentMessages.length },
        });
      }
      case "answerCallbackQuery": {
        state.answeredCallbacks.push({
          id: params.callback_query_id,
          text: params.text ?? null,
        });
        return jsonResponse(200, { ok: true, result: true });
      }
      case "editMessageText": {
        state.editedMessages.push({
          chatId: params.chat_id,
          messageId: params.message_id,
          text: params.text,
          replyMarkup: params.reply_markup ?? null,
        });
        return jsonResponse(200, { ok: true, result: true });
      }
      case "getMe":
        return jsonResponse(200, { ok: true, result: state.me });
      default:
        return jsonResponse(404, {
          ok: false,
          description: `unknown method ${method}`,
        });
    }
  };

  return { state, fetchImpl };
}

/** A Telegram update factory for the shapes the plugin handles. */
export function makeUpdate(id, over = {}) {
  return { update_id: id, ...over };
}

export function makeMessage(chatId, text, from = { id: chatId, first_name: "User" }) {
  return {
    message_id: 5000,
    date: 1763200000,
    chat: { id: chatId, type: "private" },
    from,
    ...(text !== undefined ? { text } : {}),
  };
}

export function makeCallbackQuery(id, chatId, data, messageId = 5000, from = undefined) {
  return {
    id,
    ...(from ? { from } : {}),
    message: { message_id: messageId, chat: { id: chatId, type: "private" } },
    data,
  };
}

/** Default stored settings for tests (a fake token — never a real one). */
export const TEST_SETTINGS = {
  botToken: "123:fake-test-token",
  ownerChatId: 111,
  enabled: true,
  pollTimeout: 1,
};

/**
 * Install the built plugin (dist/server.js) into a fresh fake plugin host,
 * swapping globalThis.fetch for the stub when one is given.
 */
export async function installPlugin({ settings = TEST_SETTINGS, stub = null } = {}) {
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const previousFetch = globalThis.fetch;
  if (stub) globalThis.fetch = stub.fetchImpl;
  const host = createFakePluginHost({ pluginId: "telegram-relay", settings });
  const mod = await import("../dist/server.js");
  await mod.default(host.bb);
  return {
    bb: host.bb,
    harness: host.harness,
    mod,
    async cleanup() {
      if (stub) globalThis.fetch = previousFetch;
      await host.harness.lifecycle.dispose();
    },
  };
}

/** Poll a predicate until it is true or the timeout elapses. */
export async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** Run the poller service until `predicate` holds, then stop it. */
export async function runUntil(harness, stub, predicate, timeoutMs = 5000) {
  const service = harness.behavior.runService("telegram-poller");
  try {
    await waitFor(predicate, timeoutMs);
  } finally {
    service.controller.abort();
    await service.done;
  }
}
