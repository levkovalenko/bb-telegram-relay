// Broadcast delivery service (M2): fan-out of a notification to every
// subscriber of the requested channels, with
//   - a global send pace of ~30 msg/s (sequential pacing queue),
//   - 429 handling: wait the API's retry_after, then retry,
//   - Markdown parse errors: one plain-text retry, still counts as delivered,
//   - per-recipient isolation: one chat's failure never stops the rest,
//   - auto-unsubscribe after consecutive failures per chat,
//   - one append-only delivery_log row per broadcast (metadata only).
//
// Privacy: nothing here logs or persists message bodies or the token —
// only the title, level, counters, chat ids, and API error codes/descriptions.

import type { Database } from "better-sqlite3";
import * as store from "./store.js";
import {
  TelegramError,
  TelegramNetworkError,
  TelegramRateLimitError,
  type TelegramApi,
} from "./telegram.js";

export type DeliveryLevel = "info" | "warning" | "critical";

export interface DeliveryErrorMeta {
  chat_id: number;
  code: number | "network" | "unknown";
  description: string;
}

export interface BroadcastInput {
  title: string;
  body: string;
  /** Channel ids; each must exist. */
  channels: string[];
  level?: DeliveryLevel;
}

export interface BroadcastResult {
  logId: number;
  sent: number;
  failed: number;
  /** Chat ids auto-unsubscribed during this broadcast. */
  autoUnsubscribed: number[];
}

/**
 * Persistent per-chat consecutive-failure counter (the server backs it with
 * plugin KV). `inc` returns the new count.
 */
export interface FailureCounter {
  get(chatId: number): Promise<number>;
  inc(chatId: number): Promise<number>;
  reset(chatId: number): Promise<void>;
}

export interface DeliveryLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DeliveryDeps {
  db: Database;
  api: TelegramApi;
  /** Re-read per broadcast so a (re)set token applies without a reload. */
  getToken: () => Promise<string | null>;
  log: DeliveryLog;
  failures: FailureCounter;
  /** Fired after an auto-unsubscribe changed subscriptions. */
  onChange?: () => void;
  /** Minimum delay between two outbound messages. Default: 1000/30 ms (~29.4 msg/s). */
  minIntervalMs?: number;
  /** Retries per send after a 429 before the recipient counts as failed. Default: 5. */
  maxRateRetries?: number;
}

/** Consecutive failures that trigger auto-unsubscribe. */
export const AUTO_UNSUB_AFTER_FAILURES = 3;

const ERROR_DESCRIPTION_MAX = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDelivery(deps: DeliveryDeps) {
  const intervalMs = deps.minIntervalMs ?? Math.ceil(1000 / 30);
  const maxRateRetries = deps.maxRateRetries ?? 5;
  // Global pace: shared across all concurrent broadcasts of this instance,
  // so two overlapping broadcasts still never exceed ~30 msg/s in total.
  let nextSendAt = 0;

  async function pace(): Promise<void> {
    const now = Date.now();
    if (now < nextSendAt) await sleep(nextSendAt - now);
    nextSendAt = Math.max(Date.now(), nextSendAt) + intervalMs;
  }

  /** Telegram 400 "Bad Request: can't parse entities: ..." (legacy Markdown). */
  function isMarkdownParseError(cause: unknown): boolean {
    return (
      cause instanceof TelegramError &&
      cause.status === 400 &&
      /can't parse/i.test(cause.description ?? "")
    );
  }

  async function sendToChat(token: string, chatId: number, text: string): Promise<void> {
    let rateRetries = 0;
    for (;;) {
      await pace();
      try {
        try {
          await deps.api.sendMessage(token, chatId, text, { parseMode: "Markdown" });
        } catch (cause) {
          if (isMarkdownParseError(cause)) {
            // Broken Markdown: deliver the same text as plain. A success here
            // counts as delivered; a plain failure propagates as the error.
            await pace();
            await deps.api.sendMessage(token, chatId, text);
            return;
          }
          throw cause;
        }
        return;
      } catch (cause) {
        if (cause instanceof TelegramRateLimitError && rateRetries < maxRateRetries) {
          rateRetries += 1;
          deps.log.warn(
            `broadcast chat=${chatId} 429; waiting ${cause.retryAfterSeconds}s ` +
              `(retry ${rateRetries}/${maxRateRetries})`,
          );
          await sleep(cause.retryAfterSeconds * 1000);
          continue;
        }
        throw cause;
      }
    }
  }

  function describeFailure(chatId: number, cause: unknown): DeliveryErrorMeta {
    let description: string;
    let code: DeliveryErrorMeta["code"];
    if (cause instanceof TelegramError) {
      description = cause.description ?? cause.message;
      code = cause.status ?? "unknown";
    } else if (cause instanceof Error) {
      description = cause.message;
      code = "network";
    } else {
      description = String(cause);
      code = "network";
    }
    if (description.length > ERROR_DESCRIPTION_MAX) {
      description = description.slice(0, ERROR_DESCRIPTION_MAX);
    }
    return { chat_id: chatId, code, description };
  }

  async function broadcast(input: BroadcastInput): Promise<BroadcastResult> {
    const level: DeliveryLevel = input.level ?? "info";
    const token = await deps.getToken();
    if (!token) {
      throw new Error("botToken is not configured; cannot broadcast");
    }
    for (const channelId of input.channels) {
      if (!store.getChannel(deps.db, channelId)) {
        throw new Error(`unknown channel: ${channelId}`);
      }
    }

    // Unique recipients across the requested channels: a chat subscribed to
    // several of them gets the message once.
    const chatIds: number[] = [];
    const seen = new Set<number>();
    for (const channelId of input.channels) {
      for (const row of store.listSubscribers(deps.db, channelId)) {
        if (!seen.has(row.chat_id)) {
          seen.add(row.chat_id);
          chatIds.push(row.chat_id);
        }
      }
    }

    const text = `*${input.title}*\n\n${input.body}`;
    let sent = 0;
    let failed = 0;
    const errors: DeliveryErrorMeta[] = [];
    const autoUnsubscribed: number[] = [];

    for (const chatId of chatIds) {
      try {
        await sendToChat(token, chatId, text);
        sent += 1;
        await deps.failures.reset(chatId);
      } catch (cause) {
        // One recipient's failure never stops the rest.
        failed += 1;
        const meta = describeFailure(chatId, cause);
        errors.push(meta);
        deps.log.warn(`broadcast chat=${chatId} failed code=${String(meta.code)}: ${meta.description}`);
        const consecutive = await deps.failures.inc(chatId);
        // Auto-unsubscribe after the third consecutive failure. Pure network
        // errors count toward the streak but do not trigger it: an outage
        // must not unsubscribe everyone — the counter resets on the next
        // successful delivery.
        if (consecutive >= AUTO_UNSUB_AFTER_FAILURES && !(cause instanceof TelegramNetworkError)) {
          const removed = store.unsubscribeChat(deps.db, chatId);
          if (removed.length > 0) {
            autoUnsubscribed.push(chatId);
            deps.log.info(
              `broadcast chat=${chatId} auto-unsubscribed channels=${removed.join(",")} code=${String(meta.code)}`,
            );
          }
        }
      }
    }

    const channelList = input.channels.join(",");
    const logId = store.logDelivery(deps.db, {
      channel: channelList,
      title: input.title,
      level,
      sent,
      failed,
      errors,
    });
    deps.log.info(
      `broadcast channels=${channelList} level=${level} sent=${sent} failed=${failed} logId=${logId}`,
    );
    if (autoUnsubscribed.length > 0) {
      try {
        deps.onChange?.();
      } catch {
        // notification only
      }
    }
    return { logId, sent, failed, autoUnsubscribed };
  }

  return { broadcast };
}
