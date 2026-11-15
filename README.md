# bb-telegram-relay

Multi-user Telegram relay for team notifications — a BB plugin (id
`telegram-relay`, package `bb-plugin-telegram-relay`).

An existing Telegram bot (outbound HTTPS long polling, no webhook, no ports)
receives team members' commands; channels and subscriptions live in the
plugin's own SQLite database. M1 delivers the backbone: polling service,
storage, bot commands, owner management (bot `/admin` + `bb telegram-relay`
CLI), RU/EN bot text, and a stub panel. M2 adds broadcast delivery with an
append-only delivery journal. The management UI and the end-to-end
monitoring scenario land in M3–M4.

## Bot commands

| Command | Who | Effect |
| --- | --- | --- |
| `/start` | everyone | Subscribes to the default channel (creates `general` if none exist) and greets in the user's language (RU/EN). |
| `/channels` | everyone | Inline keyboard of channels; tap to subscribe / unsubscribe. |
| `/help` | everyone | Short help. |
| `/admin list` | owner | List channels with subscriber counts. |
| `/admin create <id> [name…]` | owner | Create a channel (lowercase slug id). |
| `/admin setdefault <id>` | owner | Make a channel the `/start` default. |
| `/admin delete <id>` | owner | Delete a channel with its subscriptions. |
| `/admin subs [channel]` | owner | List subscribers (all or one channel). |

## CLI

```
bb telegram-relay status
bb telegram-relay channels
bb telegram-relay subs [channel]
bb telegram-relay channel create <id> [name...]
bb telegram-relay channel delete <id>
bb telegram-relay channel default <id>
bb telegram-relay broadcast --title <t> --body <b> --channels <c1,c2> [--level info|warning|critical]
bb telegram-relay deliveries [limit]
```

## Broadcast delivery (M2)

Automations and agents deliver team notifications with the CLI or the plugin
RPC (same contract):

```
bb telegram-relay broadcast --title <t> --body <b> --channels <c1,c2> [--level info|warning|critical]
bb telegram-relay deliveries [limit]        # recent broadcasts, metadata only
```

RPC: `broadcast({ title, body, channels, level? })` → `{ logId, sent,
failed }`, and `listDeliveries({ limit? })` (the M3 journal UI input).

Behavior:

- Recipients are the unique chats subscribed to any of the listed channels;
  each chat gets the message once. Unknown channel names are an error.
- Global pacing of ~30 msg/s; HTTP 429 waits the API's `retry_after` and
  retries the send.
- A Markdown parse 400 is retried as plain text and still counts as
  delivered.
- One recipient's failure (403 blocked, 400, network) is logged and never
  stops the rest of the fan-out.
- After 3 consecutive failures per chat its subscriptions are removed
  automatically (logged as "auto-unsubscribed"); any successful delivery
  resets the counter. Pure network errors count toward the streak but do not
  trigger the unsubscription (an outage must not unsubscribe everyone).

Every broadcast appends one row to the `delivery_log` journal (kept to the
newest 1000 rows): channel ids, title, level, sent/failed counters, and the
per-recipient error metadata `{ chat_id, code, description }`. Message
bodies are never logged or stored.

## Settings

| Key | Kind | Notes |
| --- | --- | --- |
| `botToken` | **secret** string | Bot token from @BotFather. Stored by bb in a 0600 secrets file — never in the database, the frontend bundle, or logs. Set with `bb plugin config telegram-relay set botToken <token>` (after install). |
| `ownerChatId` | number | Numeric Telegram chat id of the plugin owner; only this chat may use `/admin`. |
| `enabled` | boolean, default `true` | Toggles long polling. |
| `pollTimeout` | number, default `10` | Long-poll wait per `getUpdates` (1–30 s). |

When `botToken` is missing the plugin reports **needs-configuration** instead
of crash-looping; setting the value retries the load. The poller re-reads
settings on every loop, so `enabled` and `pollTimeout` apply without a
reload.

## Privacy & secret handling

- The token is written **only** to the plugin's secret setting. It never
  appears in source, the repository, tests, logs, or the frontend.
- Bot logs carry metadata only: chat id, command, outcome. Message text,
  user names, and the token are not logged.

## Reliability

- `getUpdates` de-duplicates by `update_id`; the acked offset is persisted in
  plugin KV so restarts do not redeliver.
- Network errors: bounded exponential backoff (1 s → 60 s).
- HTTP 429: waits the API's `retry_after`.
- HTTP 409 (another consumer polls the same token): the poller logs and stops
  gracefully (state `conflict`) instead of crash-looping. Stop the other
  consumer and run `bb plugin reload telegram-relay`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # bb plugin build
npm test            # node --test test/ (runs against the built dist/server.js)
bb plugin install . # then: bb plugin config telegram-relay set botToken <token>
```

Tests drive the built server bundle through the official fake plugin host
(`@get-bb/plugin-sdk/testing`, real temporary SQLite) with the Telegram API
mocked as a `fetch` stub — no network, no token.

## Repository

Private during development; public release and the marketplace submission are
planned for M5.

## License

MIT — see [LICENSE](./LICENSE).
