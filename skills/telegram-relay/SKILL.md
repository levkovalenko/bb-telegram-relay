---
name: telegram-relay
description: "Inspect and manage the Telegram Relay plugin (bb-plugin-telegram-relay): poller status, channels, subscribers, broadcasts, and the delivery journal, via the `bb telegram-relay` CLI. Use when the user asks about Telegram notifications, relay channels, who is subscribed, or sending a team broadcast."
---

# Telegram relay

The Telegram Relay plugin runs a long-polling Telegram bot. Users join with
`/start`, pick channels with `/channels`, and the owner manages channels from
the bot (`/admin`) or a shell. Broadcasts fan out to channel subscribers at a
pace of ~30 msg/s with 429 `retry_after` handling, and chats that keep failing
are auto-unsubscribed. A management panel (RU/EN) is in the BB UI.

## Settings

| Key | Kind | Notes |
| --- | --- | --- |
| `botToken` | secret string | Bot token from @BotFather. Stored in a 0600 secrets file — never in the database, frontend, or logs. Set with `bb plugin config telegram-relay set botToken <token>`. |
| `ownerChatId` | number | Numeric Telegram chat id of the plugin owner; only this chat may use `/admin`. |
| `enabled` | boolean, default `true` | Toggles long polling. |
| `pollTimeout` | number, default `10` | Long-poll wait per `getUpdates`, 1–30 s. |

When the token is missing the plugin reports `needs-configuration`; after
setting it, saving retries the load. The poller re-reads settings on every
loop, so `enabled`/`pollTimeout` apply without a reload.

## Commands

| Command | Effect |
| --- | --- |
| `bb telegram-relay status` | Poller state (`polling` / `idle` / `disabled` / `conflict`), last update, last error. |
| `bb telegram-relay channels` | List channels with subscriber counts; the default channel is marked. |
| `bb telegram-relay subs [channel]` | List subscribers (all, or of one channel): chat id, username, channel. |
| `bb telegram-relay channel create <id> [name…]` | Create a channel (id: lowercase slug). The first channel becomes the default. |
| `bb telegram-relay channel delete <id>` | Delete a channel with its subscriptions. |
| `bb telegram-relay channel default <id>` | Make a channel the default for `/start`. |
| `bb telegram-relay broadcast --title <t> --body <b> --channels <c1,c2> [--level info\|warning\|critical]` | Send to all subscribers of the listed channels (paced, 429-aware, auto-unsubscribes failing chats). |
| `bb telegram-relay deliveries [limit]` | Recent broadcasts (metadata only: title, level, counts, outcome). |

## Bot commands (for the users)

- `/start` — subscribe to the default channel (creates `general` if none exist).
- `/channels` — inline keyboard; tap a channel to subscribe/unsubscribe.
- `/help` — help.
- `/admin list|create|setdefault|delete|subs` — owner-only.

## Operating notes

- 409 from `api.telegram.org` means another consumer polls the same token;
  the poller stops gracefully and reports `conflict`. Stop the other consumer
  and run `bb plugin reload telegram-relay`.
- The polling offset is per-bot: after a bot token change the poller detects
  the new bot id (getMe) and starts a fresh sequence (offset 0).
- DNS: on load the plugin pins the process DNS result order to `ipv4first`
  (the host resolver serves a dead AAAA for api.telegram.org; an explicit
  `--dns-result-order` is never overwritten). The log line
  `dns result order set to ipv4first` confirms it.
- Logs carry metadata only (chat id, command, outcome); message contents and
  the token are never logged.
