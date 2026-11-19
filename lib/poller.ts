// Long polling service: a loop of getUpdates against api.telegram.org
// (outbound HTTPS, no webhook, no ports) with update_id de-duplication,
// bounded exponential backoff on network errors, 429 retry_after respect,
// and a graceful stop on 409 Conflict (another consumer holds the token).
//
// The polling offset is persisted in plugin KV (a durable cursor) so a
// restart does not redeliver updates already acked to Telegram. update_id is
// a per-bot sequence, so the offset is stored together with the bot's
// numeric id (getMe): after a bot token change the poller restarts the
// sequence from 0 instead of inheriting a foreign offset. Batches that do
// not advance the offset (the API re-delivering stale updates) get a growing
// backoff so they cannot hot-loop the API.

import {
  TelegramConflictError,
  TelegramNetworkError,
  TelegramRateLimitError,
  type TelegramApi,
  type TelegramUpdate,
} from "./telegram.js";

export interface PollerStatus {
  /** idle = stopped (reload/dispose); conflict = stopped after a 409. */
  state: "idle" | "polling" | "disabled" | "conflict";
  lastUpdateAt: string | null;
  lastError: string | null;
}

export interface PollerSettings {
  token: string | null;
  enabled: boolean;
  pollTimeoutSeconds: number;
}

export interface PollerDeps {
  api: TelegramApi;
  /** Re-read each loop iteration so setting changes apply without a reload. */
  getSettings: () => Promise<PollerSettings>;
  /** Dispatch one de-duplicated update to the command handlers. */
  dispatch: (update: TelegramUpdate) => void | Promise<void>;
  /** Durable cursor: load/save the acked polling offset. */
  loadOffset: () => Promise<number>;
  saveOffset: (offset: number) => Promise<void>;
  /**
   * Durable identity (numeric bot id) of the bot the stored offset was acked
   * for. update_id is a per-bot sequence, so the offset is only valid for
   * that bot; after a token change the sequence restarts from 0.
   */
  loadBotId: () => Promise<number | null>;
  saveBotId: (botId: number) => Promise<void>;
  log: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  status: PollerStatus;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DISABLED_SLEEP_MS = 15_000;
const GET_UPDATES_LIMIT = 100;
/** Keep recent update_ids; older ones can never re-arrive (offset already acked). */
const SEEN_RETAIN_BELOW_OFFSET = 1_000;

export const OFFSET_KV_KEY = "polling-offset";
export const BOT_ID_KV_KEY = "polling-bot-id";

/**
 * NeedsConfigurationError is matched by name by the host (no import needed),
 * which transitions the plugin to `needs-configuration` instead of
 * crash-looping the service.
 */
export function needsConfigurationError(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

/** Abortable sleep: resolves as soon as the timer fires or the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runPoller(deps: PollerDeps, signal: AbortSignal): Promise<void> {
  const { api, log, status } = deps;
  let offset = Math.max(0, await deps.loadOffset().catch(() => 0));
  const seen = new Set<number>();
  let backoffMs = INITIAL_BACKOFF_MS;
  // Stale-batch backoff: the API can get stuck returning updates that can
  // never advance the offset (e.g. an offset inherited from a previous bot).
  // Long polling only waits when a batch is empty, so such batches would
  // hot-loop the API; consecutive no-advance batches get a growing pause.
  let staleBatches = 0;
  let staleBackoffMs = INITIAL_BACKOFF_MS;
  // Bot identity, cached per token: one getMe per distinct token.
  const botIdCache = new Map<string, number>();
  let sequenceToken: string | null = null;

  const persistOffset = async (): Promise<void> => {
    try {
      await deps.saveOffset(offset);
    } catch (cause) {
      log.warn(`offset persist failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  /** Numeric bot id for a token (cached in memory; null when getMe fails). */
  const resolveBotId = async (token: string): Promise<number | null> => {
    const cached = botIdCache.get(token);
    if (cached !== undefined) return cached;
    try {
      const me = await api.getMe(token);
      botIdCache.set(token, me.id);
      return me.id;
    } catch (cause) {
      log.warn(
        `getMe failed; bot identity not verified this round: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  };

  while (!signal.aborted) {
    const settings = await deps.getSettings().catch((cause) => {
      log.error(`settings read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    if (settings === null) {
      await sleep(INITIAL_BACKOFF_MS, signal);
      continue;
    }
    if (settings.token === null || settings.token === "") {
      throw needsConfigurationError(
        "Set the bot token: `bb plugin config telegram-relay set botToken <token>`.",
      );
    }
    if (!settings.enabled) {
      if (status.state !== "disabled") {
        status.state = "disabled";
        log.info("polling disabled by settings; sleeping between checks");
      }
      await sleep(DISABLED_SLEEP_MS, signal);
      continue;
    }

    // (Re)resolve the token's bot identity: the persisted offset only belongs
    // to the bot it was acked for, so a different bot starts a fresh
    // sequence. If getMe fails, keep the previous offset and re-check next
    // round (sequenceToken stays at the previous token).
    if (settings.token !== sequenceToken) {
      const botId = await resolveBotId(settings.token);
      if (botId !== null) {
        sequenceToken = settings.token;
        const storedBotId = await deps.loadBotId().catch((cause) => {
          log.warn(
            `bot id load failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return null;
        });
        if (storedBotId !== botId) {
          log.info(
            storedBotId === null
              ? `no stored bot identity for offset ${offset}; starting a fresh polling sequence (offset reset to 0)`
              : "bot changed → new polling sequence (offset reset to 0)",
          );
          // Restart from 0: the first getUpdates returns the new bot's
          // pending updates (≤24h); the seen-set and the idempotent command
          // handlers make re-dispatching them safe.
          offset = 0;
          seen.clear();
          staleBatches = 0;
          staleBackoffMs = INITIAL_BACKOFF_MS;
          try {
            await deps.saveBotId(botId);
          } catch (cause) {
            log.warn(
              `bot id persist failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
      }
    }

    status.state = "polling";
    try {
      const updates = await api.getUpdates(settings.token, {
        offset,
        limit: GET_UPDATES_LIMIT,
        timeoutSeconds: settings.pollTimeoutSeconds,
        // Cut the in-flight request on shutdown so the service's stop window
        // is always met, even if the API (or a dead route) hangs.
        signal,
      });
      backoffMs = INITIAL_BACKOFF_MS;

      const offsetBefore = offset;
      for (const update of updates) {
        if (update.update_id < offset) {
          // Already acked — or unreachable, e.g. the API re-delivering its
          // last update while the offset is from a different bot's sequence.
          // Never dispatch and never advance on such an update.
          log.debug(`update ${update.update_id} below offset ${offset}; skipped`);
          continue;
        }
        offset = update.update_id + 1;
        if (seen.has(update.update_id)) {
          log.debug(`update ${update.update_id} duplicated; skipped`);
          continue;
        }
        seen.add(update.update_id);
        try {
          await deps.dispatch(update);
          status.lastUpdateAt = new Date().toISOString();
          status.lastError = null;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          status.lastError = `dispatch update ${update.update_id}: ${message}`;
          log.error(`dispatch update ${update.update_id} failed: ${message}`);
        }
      }

      const advanced = offset > offsetBefore;
      if (!advanced && updates.length > 0) {
        // The API is re-delivering updates below the offset; without a pause
        // this would call getUpdates back-to-back forever.
        staleBatches += 1;
        if (staleBatches === 1) {
          log.warn(`API keeps returning updates below offset ${offset}; backing off`);
        } else {
          log.debug(`stale poll batch #${staleBatches}; offset ${offset} unchanged`);
        }
        await sleep(staleBackoffMs, signal);
        staleBackoffMs = Math.min(staleBackoffMs * 2, MAX_BACKOFF_MS);
      } else {
        // Offset advanced (or nothing came back): the API is not stuck.
        staleBatches = 0;
        staleBackoffMs = INITIAL_BACKOFF_MS;
      }

      // Prune ids the offset has moved past: they cannot re-arrive.
      if (seen.size > SEEN_RETAIN_BELOW_OFFSET * 4) {
        for (const id of seen) if (id < offset - SEEN_RETAIN_BELOW_OFFSET) seen.delete(id);
      }
      if (advanced) {
        log.info(`poll batch: ${updates.length} update(s), offset now ${offset}`);
        await persistOffset();
      }
    } catch (cause) {
      if (signal.aborted) {
        // Service stopping: the in-flight request was just aborted — exit
        // quietly instead of logging a spurious network error.
        break;
      }
      if (cause instanceof TelegramConflictError) {
        // Another consumer (e.g. another plugin polling the same token) owns
        // getUpdates. Stop gracefully instead of crash-looping; the plugin
        // stays loaded and reports the conflict via status.
        status.state = "conflict";
        status.lastError = "409 Conflict: another consumer holds this bot token";
        log.error(
          `getUpdates 409 Conflict: ${cause.description ?? "unknown"} — ` +
            "another consumer is polling this token; stopping the poller. " +
            "Stop the other consumer, then run `bb plugin reload telegram-relay`.",
        );
        return;
      }
      if (cause instanceof TelegramRateLimitError) {
        status.lastError = `rate limited (429); retry after ${cause.retryAfterSeconds}s`;
        log.warn(`getUpdates 429; waiting ${cause.retryAfterSeconds}s (retry_after)`);
        await sleep(cause.retryAfterSeconds * 1000, signal);
        continue;
      }
      if (cause instanceof TelegramNetworkError) {
        status.lastError = cause.message;
        log.warn(`getUpdates network error, retry in ${backoffMs}ms: ${cause.message}`);
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }
      // Unexpected error: be resilient, back off, keep the service alive.
      const message = cause instanceof Error ? cause.message : String(cause);
      status.lastError = message;
      log.error(`getUpdates unexpected error, retry in ${backoffMs}ms: ${message}`);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  status.state = "idle";
  log.info("poller stopped");
}
