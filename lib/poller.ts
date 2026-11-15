// Long polling service: a loop of getUpdates against api.telegram.org
// (outbound HTTPS, no webhook, no ports) with update_id de-duplication,
// bounded exponential backoff on network errors, 429 retry_after respect,
// and a graceful stop on 409 Conflict (another consumer holds the token).
//
// The polling offset is persisted in plugin KV (a durable cursor) so a
// restart does not redeliver updates already acked to Telegram.

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

  const persistOffset = async (): Promise<void> => {
    try {
      await deps.saveOffset(offset);
    } catch (cause) {
      log.warn(`offset persist failed: ${cause instanceof Error ? cause.message : String(cause)}`);
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

    status.state = "polling";
    try {
      const updates = await api.getUpdates(settings.token, {
        offset,
        limit: GET_UPDATES_LIMIT,
        timeoutSeconds: settings.pollTimeoutSeconds,
      });
      backoffMs = INITIAL_BACKOFF_MS;

      for (const update of updates) {
        if (update.update_id >= offset) offset = update.update_id + 1;
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

      // Prune ids the offset has moved past: they cannot re-arrive.
      if (seen.size > SEEN_RETAIN_BELOW_OFFSET * 4) {
        for (const id of seen) if (id < offset - SEEN_RETAIN_BELOW_OFFSET) seen.delete(id);
      }
      if (updates.length > 0) {
        log.info(`poll batch: ${updates.length} update(s), offset now ${offset}`);
        await persistOffset();
      }
    } catch (cause) {
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
