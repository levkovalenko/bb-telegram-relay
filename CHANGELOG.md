# Changelog

All notable changes to this project are documented in this file.

## [0.1.0]

First public release.

- **Telegram bot relay**: outbound HTTPS long polling only — no webhooks, no
  open ports. The bot token lives exclusively in the plugin's secret
  setting (never in the database, frontend, tests, or logs).
- **Channels and subscriptions**: self-serve via the bot — `/start` joins
  the default channel, `/channels` is an inline keyboard for subscribing
  and unsubscribing; the owner manages channels from the bot (`/admin …`)
  or the CLI (`bb telegram-relay channel …`).
- **Broadcast delivery** for automations, agents, and plugins: RPC
  `broadcast({ title, body, channels, level? })` → `{ logId, sent, failed }`
  and the same contract via CLI
  (`bb telegram-relay broadcast --title … --body … --channels … [--level …]`).
- **Delivery journal**: every broadcast appends one row to `delivery_log`
  (metadata only — channel ids, title, level, sent/failed counters,
  per-recipient error metadata; message bodies are never stored), kept to
  the newest 1000 rows, browsable via `bb telegram-relay deliveries` and
  the panel.
- **Reliability**: global pacing with HTTP 429 `retry_after` handling,
  Markdown-400 fallback to plain text, per-recipient failures never stop
  the fan-out, automatic unsubscription after 3 consecutive failures per
  chat (pure network errors do not trigger it), `update_id` de-duplication
  with a persisted offset, bounded backoff, graceful `conflict` state on
  HTTP 409.
- **Management panel** (RU/EN) in the bb UI: poller status, channels,
  subscribers, the delivery journal, a test broadcast form, and settings.
- **Monitoring integration**: a reference automation
  (`automation/biom-uptime-notify.py`) turns uptime status changes into
  broadcasts and spawns an incident-diagnosis agent on confirmed
  outages — the canonical pattern for the uptime → broadcast flow.
