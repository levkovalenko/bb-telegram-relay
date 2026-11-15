// bb-plugin-telegram-relay — backend entry.
//
// Multi-user Telegram relay for team notifications.
//   M1: inbound bot commands over long polling, channels + subscriptions
//       in SQLite, owner /admin;
//   M2: broadcast delivery (pacing, 429 retry_after, Markdown fallback,
//       per-recipient isolation, auto-unsubscribe) + append-only
//       delivery_log journal + `broadcast`/`deliveries` CLI and RPC;
//   M3–M4: management UI and the end-to-end monitoring scenario.
//
//   settings (bb.settings): botToken (secret, 0600 file — never in db/frontend),
//     ownerChatId, enabled, pollTimeout
//   storage  (bb.storage.database()): channels + subscriptions (append-only
//     migrations in lib/store.ts); polling offset cursor in bb.storage.kv
//   service  (bb.background): "telegram-poller" — getUpdates loop with
//     de-duplication, backoff, 429 retry_after and graceful 409 stop
//   cli      (bb.cli): `bb telegram-relay` — status/channels/subscribers/
//     channel management from a shell
//   rpc      (bb.rpc): status + channels for the (stub, until M3) panel

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createBot } from "./lib/commands.js";
import { createDelivery, type DeliveryLevel } from "./lib/delivery.js";
import { detectLocale, translate, type MessageKey } from "./lib/i18n.js";
import { OFFSET_KV_KEY, runPoller, type PollerStatus } from "./lib/poller.js";
import * as store from "./lib/store.js";
import { createTelegramApi, type TelegramUpdate } from "./lib/telegram.js";

// Re-exported so the test suite can drive the built bundle's internals
// (type-only consumers in app.tsx never pull these into the browser bundle).
export {
  createTelegramApi,
  TelegramConflictError,
  TelegramNetworkError,
  TelegramRateLimitError,
} from "./lib/telegram.js";
export { createBot } from "./lib/commands.js";
export { createDelivery } from "./lib/delivery.js";
export { MIGRATIONS, isChannelIdValid, DELIVERY_LOG_RETENTION } from "./lib/store.js";
export type { ChannelInfo, SubscriberRow, DeliveryLogRow } from "./lib/store.js";

// Browser-safe contract: app.tsx imports only its TYPE from this module.
export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      state: z.enum(["idle", "polling", "disabled", "conflict"]),
      lastUpdateAt: z.string().nullable(),
      lastError: z.string().nullable(),
      configured: z.boolean(),
    }),
  },
  channels: {
    input: z.null(),
    output: z.object({
      channels: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          isDefault: z.boolean(),
          subscribers: z.number().int(),
        }),
      ),
      subscribers: z.number().int(),
    }),
  },
  broadcast: {
    input: z.object({
      title: z.string().min(1),
      body: z.string(),
      channels: z.array(z.string().min(1)).min(1),
      level: z.enum(["info", "warning", "critical"]).optional(),
    }),
    output: z.object({
      logId: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
    }),
  },
  listDeliveries: {
    input: z.object({ limit: z.number().int().min(1).max(1000).optional() }),
    output: z.array(
      z.object({
        id: z.number().int(),
        channel: z.string(),
        title: z.string(),
        level: z.string(),
        sent: z.number().int(),
        failed: z.number().int(),
        errors: z.array(
          z.object({
            chat_id: z.number().int(),
            code: z.union([z.number().int(), z.literal("network"), z.literal("unknown")]),
            description: z.string(),
          }),
        ),
        created_at: z.string(),
      }),
    ),
  },
});

const DELIVERY_LEVELS: readonly DeliveryLevel[] = ["info", "warning", "critical"];

/** Parse `--flag value` / `--flag=value` pairs from a CLI argv tail. */
function parseFlagArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        out[arg.slice(2)] = value;
        i += 1;
      } else {
        out[arg.slice(2)] = "true";
      }
    }
  }
  return out;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Settings: botToken is secret (0600 file, never in db/frontend); the rest
  // have defaults and are re-read by the poller on every loop iteration.
  const hostLocale = detectLocale();
  const st = (key: MessageKey) => translate(hostLocale, key);
  const settings = bb.settings.define({
    botToken: {
      type: "string",
      label: st("settings.botToken"),
      description: st("settings.botToken.desc"),
      secret: true,
    },
    ownerChatId: {
      type: "number",
      label: st("settings.ownerChatId"),
      description: st("settings.ownerChatId.desc"),
      experimental_schema: z.number().int().positive(),
    },
    enabled: {
      type: "boolean",
      label: st("settings.enabled"),
      description: st("settings.enabled.desc"),
      default: true,
    },
    pollTimeout: {
      type: "number",
      label: st("settings.pollTimeout"),
      description: st("settings.pollTimeout.desc"),
      default: 10,
      experimental_schema: z.number().int().min(1).max(30),
    },
  });

  const initial = await settings.get();
  if (!initial.botToken) {
    bb.status.needsConfiguration(
      "Set the bot token: `bb plugin config telegram-relay set botToken <token>`.",
    );
  }

  // Storage: plugin-owned SQLite (WAL) + append-only migrations.
  const db = bb.storage.database();
  bb.storage.migrate(db, [...store.MIGRATIONS]);

  const status: PollerStatus = { state: "idle", lastUpdateAt: null, lastError: null };

  async function currentSettings() {
    const values = await settings.get();
    return {
      token: values.botToken ?? null,
      ownerChatId:
        typeof values.ownerChatId === "number" ? values.ownerChatId : null,
      enabled: values.enabled,
      pollTimeoutSeconds: values.pollTimeout,
    };
  }

  const api = createTelegramApi(); // global fetch; outbound HTTPS only

  const notifyChanged = (): void => {
    bb.realtime.publish("telegram-relay-changed", {});
  };

  const bot = createBot({
    db,
    api,
    getCredentials: async () => {
      const values = await currentSettings();
      return { token: values.token, ownerChatId: values.ownerChatId };
    },
    log: bb.log,
    onChange: notifyChanged,
  });

  async function dispatch(update: TelegramUpdate): Promise<void> {
    await bot.handleUpdate(update);
  }

  // M2: broadcast delivery + auto-unsubscribe. The per-chat consecutive
  // failure counter lives in plugin KV (one JSON map: chatId -> count) —
  // durable across restarts, and it never holds message bodies.
  const DELIVERY_FAILS_KV_KEY = "delivery-failures";
  async function readFailures(): Promise<Record<string, number>> {
    const raw = await bb.storage.kv.get<Record<string, number>>(DELIVERY_FAILS_KV_KEY);
    return raw && typeof raw === "object" ? raw : {};
  }
  const failures = {
    async get(chatId: number): Promise<number> {
      const map = await readFailures();
      return map[String(chatId)] ?? 0;
    },
    async inc(chatId: number): Promise<number> {
      const map = await readFailures();
      const count = (map[String(chatId)] ?? 0) + 1;
      map[String(chatId)] = count;
      await bb.storage.kv.set(DELIVERY_FAILS_KV_KEY, map);
      return count;
    },
    async reset(chatId: number): Promise<void> {
      const map = await readFailures();
      if (map[String(chatId)] === undefined) return;
      delete map[String(chatId)];
      await bb.storage.kv.set(DELIVERY_FAILS_KV_KEY, map);
    },
  };

  const delivery = createDelivery({
    db,
    api,
    getToken: async () => (await currentSettings()).token,
    log: bb.log,
    failures,
    onChange: notifyChanged,
  });

  // The long polling service: starts after load, gets an AbortSignal on
  // reload/disable/shutdown, restarts with backoff if it crashes.
  bb.background.service("telegram-poller", {
    async start(signal) {
      await runPoller(
        {
          api,
          getSettings: async () => {
            const values = await currentSettings();
            return {
              token: values.token,
              enabled: values.enabled,
              pollTimeoutSeconds: values.pollTimeoutSeconds,
            };
          },
          dispatch,
          loadOffset: async () => (await bb.storage.kv.get<number>(OFFSET_KV_KEY)) ?? 0,
          saveOffset: async (offset) => {
            await bb.storage.kv.set(OFFSET_KV_KEY, offset);
          },
          log: bb.log,
          status,
        },
        signal,
      );
    },
  });

  bb.rpc.register(rpcContract, {
    status: async () => {
      const { botToken } = await settings.get();
      return {
        state: status.state,
        lastUpdateAt: status.lastUpdateAt,
        lastError: status.lastError,
        configured: botToken !== undefined && botToken !== "",
      };
    },
    channels: async () => ({
      channels: store.listChannels(db).map((channel) => ({
        id: channel.id,
        name: channel.name,
        description: channel.description,
        isDefault: channel.is_default === 1,
        subscribers: channel.subscribers,
      })),
      subscribers: store.subscriberCount(db),
    }),
    broadcast: async (input) => {
      const result = await delivery.broadcast({
        title: input.title,
        body: input.body,
        channels: input.channels,
        level: input.level,
      });
      return { logId: result.logId, sent: result.sent, failed: result.failed };
    },
    listDeliveries: async (input) => store.listDeliveries(db, input.limit ?? 50),
  });

  // `bb telegram-relay` — owner management from a shell (mirrors /admin).
  const usage = [
    "Usage:",
    "  bb telegram-relay status            Show poller state",
    "  bb telegram-relay channels          List channels with subscriber counts",
    "  bb telegram-relay subs [channel]    List subscribers (all, or one channel)",
    "  bb telegram-relay channel create <id> [name...]",
    "  bb telegram-relay channel delete <id>",
    "  bb telegram-relay channel default <id>",
    "  bb telegram-relay broadcast --title <t> --body <b> --channels <c1,c2> [--level info|warning|critical]",
    "  bb telegram-relay deliveries [limit]  Show recent broadcasts (metadata only)",
  ].join("\n");
  bb.cli.register({
    name: "telegram-relay",
    summary: "Inspect and manage the Telegram relay: status, channels, subscribers",
    commands: [
      { name: "status", summary: "Show poller state", usage: "bb telegram-relay status" },
      {
        name: "channels",
        summary: "List channels",
        usage: "bb telegram-relay channels",
      },
      {
        name: "subs",
        summary: "List subscribers",
        usage: "bb telegram-relay subs [channel]",
      },
      {
        name: "channel",
        summary: "Create / delete / setdefault a channel",
        usage:
          "bb telegram-relay channel create <id> [name...] | delete <id> | default <id>",
      },
      {
        name: "broadcast",
        summary: "Send a message to subscribers of the given channels",
        usage:
          "bb telegram-relay broadcast --title <t> --body <b> --channels <c1,c2> [--level info|warning|critical]",
      },
      {
        name: "deliveries",
        summary: "Show recent broadcasts (metadata only)",
        usage: "bb telegram-relay deliveries [limit]",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const s = status;
          return {
            exitCode: 0,
            stdout: `state: ${s.state}\nlast update: ${s.lastUpdateAt ?? "never"}\nlast error: ${s.lastError ?? "-"}`,
          };
        }
        case "channels": {
          const rows = store.listChannels(db);
          if (rows.length === 0) return { exitCode: 0, stdout: "No channels yet." };
          return {
            exitCode: 0,
            stdout: rows
              .map(
                (channel) =>
                  `${channel.id} — ${channel.name} (${channel.subscribers} subscriber(s))${channel.is_default ? " [default]" : ""}`,
              )
              .join("\n"),
          };
        }
        case "subs": {
          const channelId = rest[0];
          if (channelId && !store.getChannel(db, channelId)) {
            return { exitCode: 1, stderr: `No channel "${channelId}".` };
          }
          const rows = store.listSubscribers(db, channelId);
          if (rows.length === 0) return { exitCode: 0, stdout: "No subscribers." };
          return {
            exitCode: 0,
            stdout: rows
              .map((row) => `${row.chat_id}  ${row.tg_username ?? ""}  [${row.channel_id}]`)
              .join("\n"),
          };
        }
        case "channel": {
          const [sub, ...args] = rest;
          switch (sub) {
            case "create": {
              const id = args[0] ?? "";
              const name = args.slice(1).join(" ").trim();
              if (!store.isChannelIdValid(id)) {
                return {
                  exitCode: 1,
                  stderr: "Channel ids use 1–64 lowercase letters, digits or dashes, starting with a letter or digit.",
                };
              }
              if (store.getChannel(db, id)) {
                return { exitCode: 1, stderr: `Channel "${id}" already exists.` };
              }
              const first = store.listChannels(db).length === 0;
              store.createChannel(db, { id, name: name || undefined, isDefault: first });
              notifyChanged();
              return {
                exitCode: 0,
                stdout: `Created channel "${id}"${first ? " (default — no other channels existed)" : ""}.`,
              };
            }
            case "delete": {
              const id = args[0] ?? "";
              if (!store.deleteChannel(db, id)) {
                return { exitCode: 1, stderr: `No channel "${id}".` };
              }
              notifyChanged();
              return { exitCode: 0, stdout: `Deleted channel "${id}" with its subscriptions.` };
            }
            case "default": {
              const id = args[0] ?? "";
              if (!store.setDefaultChannel(db, id)) {
                return { exitCode: 1, stderr: `No channel "${id}".` };
              }
              notifyChanged();
              return { exitCode: 0, stdout: `"${id}" is now the default channel.` };
            }
            default:
              return { exitCode: 1, stderr: usage };
          }
        }
        case "broadcast": {
          const flags = parseFlagArgs(rest);
          const title = flags.title ?? "";
          const body = flags.body;
          const channelsRaw = flags.channels ?? "";
          const level = flags.level;
          if (!title || body === undefined || channelsRaw === "") {
            return {
              exitCode: 1,
              stderr:
                "broadcast requires --title <t> --body <b> --channels <c1,c2> [--level info|warning|critical]",
            };
          }
          if (level !== undefined && !DELIVERY_LEVELS.includes(level as DeliveryLevel)) {
            return {
              exitCode: 1,
              stderr: "--level must be one of: info, warning, critical",
            };
          }
          const channels = channelsRaw.split(",").map((part) => part.trim()).filter((part) => part !== "");
          if (channels.length === 0) {
            return { exitCode: 1, stderr: "--channels must name at least one channel" };
          }
          try {
            const result = await delivery.broadcast({
              title,
              body,
              channels,
              level: (level ?? "info") as DeliveryLevel,
            });
            const lines = [
              `sent: ${result.sent}`,
              `failed: ${result.failed}`,
              `logId: ${result.logId}`,
              ...result.autoUnsubscribed.map((chatId) => `auto-unsubscribed chat ${chatId}`),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          } catch (cause) {
            return {
              exitCode: 1,
              stderr: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }
        case "deliveries": {
          const limit = rest[0] !== undefined ? Number.parseInt(rest[0], 10) : 20;
          if (!Number.isInteger(limit) || limit < 1) {
            return { exitCode: 1, stderr: "deliveries expects a positive integer limit" };
          }
          const rows = store.listDeliveries(db, Math.min(limit, 1000));
          if (rows.length === 0) return { exitCode: 0, stdout: "No deliveries logged yet." };
          return {
            exitCode: 0,
            stdout: rows
              .map(
                (row) =>
                  `#${row.id} ${row.created_at} [${row.level}] ${row.channel} ` +
                    `sent=${row.sent} failed=${row.failed} ${row.title}`,
              )
              .join("\n"),
          };
        }
        default:
          return { exitCode: 1, stderr: usage };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
