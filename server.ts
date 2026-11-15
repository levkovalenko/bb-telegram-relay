// bb-plugin-telegram-relay — backend entry.
//
// Multi-user Telegram relay for team notifications (M1: inbound bot commands
// over long polling, channels + subscriptions in SQLite, owner /admin;
// broadcast delivery and the management UI land in M2–M4).
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
export { MIGRATIONS, isChannelIdValid } from "./lib/store.js";
export type { ChannelInfo, SubscriberRow } from "./lib/store.js";

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
});

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
        default:
          return { exitCode: 1, stderr: usage };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
