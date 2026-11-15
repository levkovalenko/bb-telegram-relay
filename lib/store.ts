// SQLite repository for channels and subscriptions (bb.storage.database()).
//
// Migrations are append-only: bb.storage.migrate records each statement by
// index, so shipped statements are never reordered or edited — only pushed.

import type { Database } from "better-sqlite3";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id       INTEGER NOT NULL,
    channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    tg_username   TEXT,
    subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at  TEXT,
    UNIQUE (chat_id, channel_id)
  )`,
] as const;

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  is_default: number;
  created_at: string;
}

export interface ChannelInfo extends ChannelRow {
  subscribers: number;
}

export interface SubscriberRow {
  chat_id: number;
  channel_id: string;
  tg_username: string | null;
  subscribed_at: string;
  last_seen_at: string | null;
}

/** Channel id grammar: lowercase slug, 1–64 chars. */
export const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function listChannels(db: Database): ChannelInfo[] {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_id = c.id) AS subscribers
       FROM channels c ORDER BY c.is_default DESC, c.id ASC`,
    )
    .all() as ChannelInfo[];
}

export function getChannel(db: Database, id: string): ChannelRow | undefined {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined;
}

export function isChannelIdValid(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}

export function createChannel(
  db: Database,
  input: { id: string; name?: string; description?: string; isDefault?: boolean },
): ChannelRow {
  if (!isChannelIdValid(input.id)) throw new Error(`invalid channel id: ${input.id}`);
  if (getChannel(db, input.id)) throw new Error(`channel exists: ${input.id}`);
  const isDefault = input.isDefault ? 1 : 0;
  db.prepare(
    `INSERT INTO channels (id, name, description, is_default) VALUES (?, ?, ?, ?)`,
  ).run(input.id, input.name ?? input.id, input.description ?? "", isDefault);
  return getChannel(db, input.id)!;
}

export function deleteChannel(db: Database, id: string): boolean {
  // FK cascade removes the channel's subscriptions.
  const result = db.prepare(`DELETE FROM channels WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function setDefaultChannel(db: Database, id: string): boolean {
  if (!getChannel(db, id)) return false;
  db.exec(`UPDATE channels SET is_default = 0`);
  db.prepare(`UPDATE channels SET is_default = 1 WHERE id = ?`).run(id);
  return true;
}

/**
 * The channel /start subscribes to: the explicit default, else the first
 * channel, else a freshly created "general" default.
 */
export function getOrCreateDefaultChannel(
  db: Database,
): { channel: ChannelRow; created: boolean } {
  const defaultRow = db
    .prepare(`SELECT * FROM channels WHERE is_default = 1 LIMIT 1`)
    .get() as ChannelRow | undefined;
  if (defaultRow) return { channel: defaultRow, created: false };
  const first = db.prepare(`SELECT * FROM channels ORDER BY created_at, id LIMIT 1`).get() as
    | ChannelRow
    | undefined;
  if (first) return { channel: first, created: false };
  const created = createChannel(db, { id: "general", name: "General", isDefault: true });
  return { channel: created, created: true };
}

export function subscribe(
  db: Database,
  chatId: number,
  channelId: string,
  tgUsername?: string | null,
): void {
  db.prepare(
    `INSERT INTO subscriptions (chat_id, channel_id, tg_username) VALUES (?, ?, ?)
     ON CONFLICT (chat_id, channel_id) DO UPDATE SET
       tg_username = COALESCE(excluded.tg_username, subscriptions.tg_username)`,
  ).run(chatId, channelId, tgUsername ?? null);
}

export function unsubscribe(db: Database, chatId: number, channelId: string): boolean {
  const result = db
    .prepare(`DELETE FROM subscriptions WHERE chat_id = ? AND channel_id = ?`)
    .run(chatId, channelId);
  return result.changes > 0;
}

export function isSubscribed(db: Database, chatId: number, channelId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS one FROM subscriptions WHERE chat_id = ? AND channel_id = ?`)
    .get(chatId, channelId);
  return row !== undefined;
}

/** Subscribe if absent, unsubscribe if present. Returns true when now subscribed. */
export function toggleSubscription(
  db: Database,
  chatId: number,
  channelId: string,
  tgUsername?: string | null,
): boolean {
  if (isSubscribed(db, chatId, channelId)) return !unsubscribe(db, chatId, channelId);
  subscribe(db, chatId, channelId, tgUsername);
  return true;
}

export function listSubscribers(db: Database, channelId?: string): SubscriberRow[] {
  if (channelId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM subscriptions WHERE channel_id = ? ORDER BY chat_id`,
      )
      .all(channelId) as SubscriberRow[];
  }
  return db.prepare(`SELECT * FROM subscriptions ORDER BY channel_id, chat_id`).all() as SubscriberRow[];
}

export function touchLastSeen(db: Database, chatId: number): void {
  db.prepare(
    `UPDATE subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE chat_id = ?`,
  ).run(chatId);
}

export function subscriberCount(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM subscriptions`).get() as {
    count: number;
  };
  return row.count;
}
