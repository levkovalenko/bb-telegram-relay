// Bot command handlers: /start, /channels, /help, /admin and the
// /channels inline-keyboard callback queries.
//
// Privacy: logs carry metadata only (chat id, command, outcome) — never
// message text, user names, or the token.

import type { Database } from "better-sqlite3";
import { localeFromLanguageCode, translate, type Locale } from "./i18n.js";
import * as store from "./store.js";
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramInlineButton,
  TelegramMessage,
  TelegramReplyMarkup,
  TelegramUpdate,
} from "./telegram.js";

export interface BotLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BotCredentials {
  token: string | null;
  ownerChatId: number | null;
}

export interface BotDeps {
  db: Database;
  api: TelegramApi;
  /** Re-read on every command so setting changes apply without a reload. */
  getCredentials: () => Promise<BotCredentials>;
  log: BotLog;
  /** Fired after any channel/subscription change (the server publishes realtime). */
  onChange?: () => void;
}

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:[ \t]+([\s\S]*))?$/;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createBot(deps: BotDeps) {
  const { db, api, log } = deps;
  const changed = (): void => {
    try {
      deps.onChange?.();
    } catch {
      // notification only; never fail a command because of it
    }
  };

  async function credentials(): Promise<BotCredentials> {
    try {
      return await deps.getCredentials();
    } catch (cause) {
      log.error(`settings read failed: ${errorMessage(cause)}`);
      return { token: null, ownerChatId: null };
    }
  }

  async function reply(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<void> {
    const { token } = await credentials();
    if (!token) return;
    try {
      await api.sendMessage(token, chatId, text, replyMarkup ? { replyMarkup } : undefined);
    } catch (cause) {
      log.warn(`sendMessage to chat ${chatId} failed: ${errorMessage(cause)}`);
    }
  }

  function channelKeyboard(subscribedIds: Set<string>): TelegramReplyMarkup {
    const rows: TelegramInlineButton[][] = store.listChannels(db).map((channel) => [
      {
        text: subscribedIds.has(channel.id) ? `✓ ${channel.name}` : channel.name,
        callback_data: `tg:${channel.id}`,
      },
    ]);
    return { inline_keyboard: rows };
  }

  async function handleStart(message: TelegramMessage, locale: Locale): Promise<void> {
    const { channel, created } = store.getOrCreateDefaultChannel(db);
    store.subscribe(db, message.chat.id, channel.id, message.from?.username ?? null);
    log.info(`/start chat=${message.chat.id} result=ok channel=${channel.id}`);
    changed();
    await reply(
      message.chat.id,
      translate(locale, created ? "bot.startNoDefault" : "bot.welcome", {
        channel: channel.name,
      }),
    );
  }

  async function handleChannels(message: TelegramMessage, locale: Locale): Promise<void> {
    const channels = store.listChannels(db);
    log.info(`/channels chat=${message.chat.id} channels=${channels.length}`);
    if (channels.length === 0) {
      await reply(message.chat.id, translate(locale, "bot.channelsEmpty"));
      return;
    }
    const subscribedIds = new Set(
      store.listSubscribers(db).filter((row) => row.chat_id === message.chat.id).map((row) => row.channel_id),
    );
    await reply(message.chat.id, translate(locale, "bot.channelsTitle"), channelKeyboard(subscribedIds));
  }

  async function handleAdmin(
    message: TelegramMessage,
    locale: Locale,
    rawArgs: string,
  ): Promise<void> {
    const { token, ownerChatId } = await credentials();
    const isOwner =
      ownerChatId !== null &&
      message.chat.id === ownerChatId &&
      (message.from === undefined || message.from.id === ownerChatId);
    if (!isOwner) {
      log.warn(`/admin chat=${message.chat.id} result=forbidden`);
      await reply(message.chat.id, translate(locale, "bot.adminForbidden"));
      return;
    }
    if (!token) {
      log.warn(`/admin chat=${message.chat.id} result=skipped reason=no-token`);
      return;
    }
    const [sub, ...rest] = rawArgs.split(/\s+/).filter((part) => part !== "");

    switch (sub) {
      case undefined:
      case "":
        log.info(`/admin chat=${message.chat.id} sub=usage`);
        await reply(message.chat.id, translate(locale, "bot.adminUsage"));
        return;

      case "list": {
        const rows = store.listChannels(db);
        log.info(`/admin chat=${message.chat.id} sub=list channels=${rows.length}`);
        if (rows.length === 0) {
          await reply(message.chat.id, translate(locale, "bot.adminListEmpty"));
          return;
        }
        const lines = rows.map((channel) =>
          translate(locale, "bot.adminListRow", {
            id: channel.id,
            name: channel.name,
            count: channel.subscribers,
          }) + (channel.is_default ? translate(locale, "bot.adminListDefault") : ""),
        );
        await reply(message.chat.id, `${translate(locale, "bot.adminList")}\n${lines.join("\n")}`);
        return;
      }

      case "create": {
        const id = rest[0] ?? "";
        const name = rest.slice(1).join(" ").trim();
        if (!store.isChannelIdValid(id)) {
          log.warn(`/admin chat=${message.chat.id} sub=create result=bad-id`);
          await reply(message.chat.id, translate(locale, "bot.adminBadId"));
          return;
        }
        if (store.getChannel(db, id)) {
          log.warn(`/admin chat=${message.chat.id} sub=create result=exists id=${id}`);
          await reply(message.chat.id, translate(locale, "bot.adminExists", { id }));
          return;
        }
        const first = store.listChannels(db).length === 0;
        store.createChannel(db, { id, name: name || undefined, isDefault: first });
        changed();
        log.info(`/admin chat=${message.chat.id} sub=create result=ok id=${id}`);
        await reply(
          message.chat.id,
          translate(locale, first ? "bot.adminCreatedDefault" : "bot.adminCreated", { id }),
        );
        return;
      }

      case "setdefault": {
        const id = rest[0] ?? "";
        const done = store.setDefaultChannel(db, id);
        if (done) changed();
        log.info(`/admin chat=${message.chat.id} sub=setdefault id=${id} result=${done ? "ok" : "missing"}`);
        await reply(
          message.chat.id,
          translate(locale, done ? "bot.adminDefaultSet" : "bot.adminMissing", { id }),
        );
        return;
      }

      case "delete": {
        const id = rest[0] ?? "";
        const done = store.deleteChannel(db, id);
        if (done) changed();
        log.info(`/admin chat=${message.chat.id} sub=delete id=${id} result=${done ? "ok" : "missing"}`);
        await reply(
          message.chat.id,
          translate(locale, done ? "bot.adminDeleted" : "bot.adminMissing", { id }),
        );
        return;
      }

      case "subs": {
        const channelId = rest[0] ?? "";
        const hasChannel = channelId !== "" ? store.getChannel(db, channelId) !== undefined : true;
        if (channelId !== "" && !hasChannel) {
          log.warn(`/admin chat=${message.chat.id} sub=subs id=${channelId} result=missing`);
          await reply(message.chat.id, translate(locale, "bot.adminMissing", { id: channelId }));
          return;
        }
        const rows = store.listSubscribers(db, channelId !== "" ? channelId : undefined);
        log.info(`/admin chat=${message.chat.id} sub=subs channel=${channelId || "all"} subscribers=${rows.length}`);
        if (rows.length === 0) {
          await reply(message.chat.id, translate(locale, "bot.adminSubsEmpty"));
          return;
        }
        const lines = rows.map((row) =>
          translate(locale, "bot.adminSubsRow", {
            username: row.tg_username ?? "—",
            chatId: row.chat_id,
          }),
        );
        const title =
          channelId !== ""
            ? translate(locale, "bot.adminSubs", { channel: channelId })
            : translate(locale, "bot.adminSubsAll");
        await reply(message.chat.id, `${title}\n${lines.join("\n")}`);
        return;
      }

      default:
        log.warn(`/admin chat=${message.chat.id} sub=unknown result=usage`);
        await reply(message.chat.id, translate(locale, "bot.adminUsage"));
    }
  }

  async function handleCallbackQuery(cq: TelegramCallbackQuery, locale: Locale): Promise<void> {
    const { token } = await credentials();
    const chatId = cq.message?.chat.id;
    const data = cq.data ?? "";
    const logPrefix = `callback chat=${chatId ?? "?"}`;

    const finish = (text: string): void => {
      if (!token) return;
      api
        .answerCallbackQuery(token, cq.id, text)
        .catch((cause) => log.warn(`${logPrefix} answerCallbackQuery failed: ${errorMessage(cause)}`));
    };

    if (!data.startsWith("tg:") || chatId === undefined) {
      log.warn(`${logPrefix} result=ignored reason=bad-data`);
      finish("");
      return;
    }
    const channelId = data.slice(3);
    const channel = store.getChannel(db, channelId);
    if (!channel) {
      log.warn(`${logPrefix} channel=${channelId} result=missing`);
      finish(translate(locale, "bot.adminMissing", { id: channelId }));
      return;
    }

    const nowSubscribed = store.toggleSubscription(
      db,
      chatId,
      channelId,
      cq.from?.username ?? null,
    );
    log.info(`${logPrefix} channel=${channelId} result=${nowSubscribed ? "subscribed" : "unsubscribed"}`);
    changed();
    finish(
      translate(locale, nowSubscribed ? "bot.channelSubscribed" : "bot.channelUnsubscribed", {
        channel: channel.name,
      }),
    );

    // Refresh the /channels message the button belongs to (best effort).
    const messageId = cq.message?.message_id;
    if (messageId !== undefined && token) {
      const subscribedIds = new Set(
        store.listSubscribers(db).filter((row) => row.chat_id === chatId).map((row) => row.channel_id),
      );
      const text =
        store.listChannels(db).length === 0
          ? translate(locale, "bot.channelsEmpty")
          : translate(locale, "bot.channelsTitle");
      api
        .editMessageText(token, chatId, messageId, text, {
          replyMarkup: channelKeyboard(subscribedIds),
        })
        .catch((cause) =>
          log.debug(`${logPrefix} editMessageText skipped: ${errorMessage(cause)}`),
        );
    }
  }

  /** Entry point from the poller: one Telegram update, handled fire-and-forget. */
  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const cq = update.callback_query;
    if (!message && !cq) return;

    const locale: Locale = localeFromLanguageCode(
      (message?.from ?? cq?.from)?.language_code,
    );

    if (message) {
      store.touchLastSeen(db, message.chat.id);
      const text = (message.text ?? "").trim();
      const match = COMMAND_RE.exec(text);
      if (!match) {
        if (text !== "") {
          log.debug(`message chat=${message.chat.id} result=hint`);
          await reply(message.chat.id, translate(locale, "bot.plainTextHint"));
        }
        return;
      }
      const command = match[1].toLowerCase();
      const args = (match[2] ?? "").trim();
      switch (command) {
        case "start":
          await handleStart(message, locale);
          return;
        case "channels":
          await handleChannels(message, locale);
          return;
        case "help":
          log.info(`/help chat=${message.chat.id} result=ok`);
          await reply(message.chat.id, translate(locale, "bot.help"));
          return;
        case "admin":
          await handleAdmin(message, locale, args);
          return;
        default:
          log.warn(`/unknown chat=${message.chat.id} command=${command} result=unknown`);
          await reply(message.chat.id, translate(locale, "bot.unknownCommand"));
      }
      return;
    }

    await handleCallbackQuery(cq!, locale);
  }

  return { handleUpdate };
}
