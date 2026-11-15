// Bot commands: /start subscription (RU/EN), /channels inline keyboard +
// callback toggling, /help, /admin CRUD with owner enforcement — all driven
// through the real poller service with the Telegram API fetch-stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramFetchStub,
  installPlugin,
  makeCallbackQuery,
  makeMessage,
  makeUpdate,
  runUntil,
  TEST_SETTINGS,
} from "./helpers.mjs";

const OWNER = 111;
const OTHER = 222;

function dbRows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

test("/start subscribes to the default channel (creates general, RU greeting)", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(1, {
          message: makeMessage(OWNER, "/start", {
            id: OWNER,
            first_name: "V",
            username: "owner",
            language_code: "ru",
          }),
        }),
      ],
    });
    await runUntil(harness, stub, () => stub.state.sentMessages.length >= 1);

    const db = bb.storage.database();
    const channels = dbRows(db, "SELECT * FROM channels");
    assert.equal(channels.length, 1);
    assert.equal(channels[0].id, "general");
    assert.equal(channels[0].is_default, 1);
    const subs = dbRows(db, "SELECT * FROM subscriptions");
    assert.deepEqual(
      subs.map((row) => [row.chat_id, row.channel_id, row.tg_username]),
      [[OWNER, "general", "owner"]],
    );
    // Russian greeting for the first-ever /start: channels were empty, so the
    // bot created "general" and told the user about it.
    const sent = stub.state.sentMessages[0];
    assert.equal(sent.chatId, OWNER);
    assert.match(sent.text, /создали канал «general» и подписали тебя/);
  } finally {
    await cleanup();
  }
});

test("/start for a second user and an English greeting", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(1, { message: makeMessage(OWNER, "/start", { id: OWNER, first_name: "V" }) }),
        makeUpdate(2, {
          message: makeMessage(OTHER, "/start", {
            id: OTHER,
            first_name: "U",
            username: "user",
            language_code: "en",
          }),
        }),
      ],
    });
    await runUntil(harness, stub, () => stub.state.sentMessages.length >= 2);

    const db = bb.storage.database();
    const subs = dbRows(db, "SELECT chat_id FROM subscriptions ORDER BY chat_id");
    assert.deepEqual(
      subs.map((row) => row.chat_id),
      [OWNER, OTHER],
    );
    const english = stub.state.sentMessages.find((m) => m.chatId === OTHER);
    assert.match(english.text, /subscribed to the “General” channel/);
  } finally {
    await cleanup();
  }
});

test("/channels lists channels; callback toggles subscription", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    // Owner creates a second channel via the CLI surface.
    const created = await harness.behavior.runCli([
      "channel",
      "create",
      "monitoring",
      "Monitoring",
    ]);
    assert.equal(created.exitCode, 0);

    // 1) /channels from the owner: keyboard with both channels.
    stub.state.getUpdatesQueue.push({
      updates: [makeUpdate(1, { message: makeMessage(OWNER, "/channels", { id: OWNER, first_name: "V" }) })],
    });
    const service = harness.behavior.runService("telegram-poller");
    await waitForKeyboard(stub);
    const keyboard = stub.state.sentMessages[0];
    const buttons = keyboard.replyMarkup.inline_keyboard.map((row) => row[0]);
    // Only "monitoring" exists in this test (no /start → no "general" yet).
    assert.deepEqual(
      buttons.map((button) => button.callback_data),
      ["tg:monitoring"],
    );
    assert.match(buttons[0].text, /Monitoring/);

    // 2) Tap monitoring: subscribes, answers, refreshes the message.
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(2, {
          callback_query: makeCallbackQuery("cb1", OWNER, "tg:monitoring", 1001, {
            id: OWNER,
            first_name: "V",
            username: "owner",
          }),
        }),
      ],
    });
    await runCallback(stub, service, 1);
    let db = bb.storage.database();
    assert.equal(
      dbRows(db, "SELECT 1 FROM subscriptions WHERE chat_id = ? AND channel_id = ?", OWNER, "monitoring")
        .length,
      1,
      "callback should subscribe",
    );
    assert.equal(stub.state.answeredCallbacks.length, 1);
    assert.match(stub.state.answeredCallbacks[0].text, /general|monitoring|подписк|Subscribed/i);

    // 3) Tap again: unsubscribes.
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(3, {
          callback_query: makeCallbackQuery("cb2", OWNER, "tg:monitoring", 1001, {
            id: OWNER,
            first_name: "V",
            username: "owner",
          }),
        }),
      ],
    });
    await runCallback(stub, service, 2);
    db = bb.storage.database();
    assert.equal(
      dbRows(db, "SELECT 1 FROM subscriptions WHERE chat_id = ? AND channel_id = ?", OWNER, "monitoring")
        .length,
      0,
      "second callback should unsubscribe",
    );
    assert.equal(stub.state.answeredCallbacks.length, 2);
    service.controller.abort();
    await service.done;
  } finally {
    await cleanup();
  }
});

async function waitForKeyboard(stub) {
  for (let i = 0; i < 500; i++) {
    const sent = stub.state.sentMessages.find((m) => m.replyMarkup !== null);
    if (sent) return sent;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no keyboard message was sent");
}

function runCallback(stub, service, expectAnswerCount) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (stub.state.answeredCallbacks.length >= expectAnswerCount) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error(`callback ${expectAnswerCount} not answered in time`));
      }
    }, 10);
  });
}

test("/help answers in the user's language; unknown command is answered", async () => {
  const stub = createTelegramFetchStub();
  const { harness, cleanup } = await installPlugin({ stub });
  try {
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(1, {
          message: makeMessage(OTHER, "/help", {
            id: OTHER,
            first_name: "U",
            language_code: "ru",
          }),
        }),
        makeUpdate(2, { message: makeMessage(OTHER, "/frobnicate") }),
      ],
    });
    await runUntil(harness, stub, () => stub.state.sentMessages.length >= 2);
    const help = stub.state.sentMessages.find((m) => m.text.includes("/start"));
    assert.match(help.text, /Команды/);
    const unknown = stub.state.sentMessages.find(
      (m) => /Неизвестная|Unknown command/.test(m.text),
    );
    assert.ok(unknown);
  } finally {
    await cleanup();
  }
});

test("/admin: owner CRUD and forbidden for non-owner", async () => {
  const stub = createTelegramFetchStub();
  const { bb, harness, cleanup } = await installPlugin({ stub });
  try {
    const db = bb.storage.database();
    const send = (chatId, text, updateId) =>
      stub.state.getUpdatesQueue.push({
        updates: [makeUpdate(updateId, { message: makeMessage(chatId, text, { id: chatId, first_name: "U" }) })],
      });

    const service = harness.behavior.runService("telegram-poller");

    // Owner: /start creates the default "general" channel and subscribes the owner.
    send(OWNER, "/start", 1);
    await untilSent(stub, 1);
    assert.equal(
      dbRows(db, "SELECT 1 FROM channels WHERE id = 'general'").length,
      1,
    );

    // Non-owner is refused (and nothing is created).
    send(OTHER, "/admin create hacked Hacked", 2);
    await untilSent(stub, 2);
    assert.equal(
      dbRows(db, "SELECT 1 FROM channels WHERE id = 'hacked'").length,
      0,
      "non-owner must not create channels",
    );
    assert.match(stub.state.sentMessages.at(-1).text, /только владельцу|only the owner/i);

    // Owner: create (not default, since channels already exist).
    send(OWNER, "/admin create monitoring Monitoring", 3);
    await untilSent(stub, 3);
    assert.equal(
      dbRows(db, "SELECT 1 FROM channels WHERE id = 'monitoring'").length,
      1,
    );
    assert.equal(
      db.prepare("SELECT is_default FROM channels WHERE id = 'monitoring'").get()
        .is_default,
      0,
      "second channel is not the default",
    );

    // Owner: duplicate create is reported.
    send(OWNER, "/admin create monitoring", 4);
    await untilSent(stub, 4);
    assert.match(stub.state.sentMessages.at(-1).text, /уже существует|already exists/i);

    // Owner: setdefault.
    send(OWNER, "/admin setdefault monitoring", 5);
    await untilSent(stub, 5);
    const row = db.prepare("SELECT is_default FROM channels WHERE id = 'monitoring'").get();
    assert.equal(row.is_default, 1);
    const general = db.prepare("SELECT is_default FROM channels WHERE id = 'general'").get();
    assert.equal(general.is_default, 0);

    // Owner: list.
    send(OWNER, "/admin list", 6);
    await untilSent(stub, 6);
    assert.match(stub.state.sentMessages.at(-1).text, /monitoring/);
    assert.match(stub.state.sentMessages.at(-1).text, /general/);

    // Owner: subscribe to monitoring via the inline keyboard, then list subscribers.
    stub.state.getUpdatesQueue.push({
      updates: [
        makeUpdate(7, {
          callback_query: makeCallbackQuery("cbx", OWNER, "tg:monitoring", 999, {
            id: OWNER,
            first_name: "V",
            username: "owner",
          }),
        }),
      ],
    });
    await runCallback(stub, service, 1);
    send(OWNER, "/admin subs monitoring", 8);
    await untilSent(stub, 7);
    assert.match(stub.state.sentMessages.at(-1).text, /111/);
    assert.match(stub.state.sentMessages.at(-1).text, /owner/);

    // Owner: bad id is rejected.
    send(OWNER, "/admin create BAD_ID", 9);
    await untilSent(stub, 8);
    assert.match(stub.state.sentMessages.at(-1).text, /идентификатор|ids use/i);

    // Owner: delete removes the channel and its subscriptions.
    send(OWNER, "/admin delete monitoring", 10);
    await untilSent(stub, 9);
    assert.equal(dbRows(db, "SELECT 1 FROM channels WHERE id = 'monitoring'").length, 0);
    assert.equal(
      dbRows(db, "SELECT 1 FROM subscriptions WHERE channel_id = 'monitoring'").length,
      0,
      "subscriptions cascade with the channel",
    );

    service.controller.abort();
    await service.done;
  } finally {
    await cleanup();
  }
});

/** Wait until at least `n` messages were sent to any chat (total). */
async function untilSent(stub, n) {
  for (let i = 0; i < 500; i++) {
    if (stub.state.sentMessages.length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`expected ${n} sent messages, got ${stub.state.sentMessages.length}`);
}
