// listSubscribers RPC (M3): the panel's subscribers table, driven through
// the real plugin (built dist/server.js) with the store seeded directly.

import test from "node:test";
import assert from "node:assert/strict";
import { installPlugin } from "./helpers.mjs";

function seedChannel(db, id, name = id) {
  db.prepare(`INSERT INTO channels (id, name) VALUES (?, ?)`).run(id, name);
}

function seedSubscriber(db, chatId, channelId, username = null) {
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, ?, ?)`,
  ).run(chatId, channelId, username);
}

test("listSubscribers RPC: all rows with metadata, filtered by channel", async () => {
  const { bb, harness, cleanup } = await installPlugin();
  try {
    const db = bb.storage.database();
    seedChannel(db, "monitoring", "Monitoring");
    seedChannel(db, "incidents", "Incidents");
    seedSubscriber(db, 201, "monitoring", "alice");
    seedSubscriber(db, 201, "incidents", "alice");
    seedSubscriber(db, 202, "monitoring", "bob");
    db.prepare(
      `UPDATE subscriptions SET last_seen_at = '2026-11-15T10:00:00.000Z'
       WHERE chat_id = 201 AND channel_id = 'monitoring'`,
    ).run();

    // All subscriptions, one row per (chat, channel) pair.
    const all = await harness.behavior.callRpc("listSubscribers", {});
    assert.equal(all.length, 3);
    const aliceMonitoring = all.find(
      (row) => row.chat_id === 201 && row.channel_id === "monitoring",
    );
    assert.equal(aliceMonitoring.tg_username, "alice");
    assert.equal(aliceMonitoring.last_seen_at, "2026-11-15T10:00:00.000Z");
    assert.match(aliceMonitoring.subscribed_at, /^\d{4}-\d{2}-\d{2}T/);
    const bob = all.find((row) => row.chat_id === 202);
    assert.equal(bob.tg_username, "bob");
    assert.equal(bob.last_seen_at, null);

    // Filtered to one channel.
    const filtered = await harness.behavior.callRpc("listSubscribers", {
      channel: "incidents",
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].chat_id, 201);
    assert.equal(filtered[0].channel_id, "incidents");
  } finally {
    await cleanup();
  }
});
