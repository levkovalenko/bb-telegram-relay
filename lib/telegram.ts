// Minimal Telegram Bot API client for the relay: outbound HTTPS only
// (long polling getUpdates, no webhook and no ports). The fetch implementation
// is injectable so tests stub the API without touching the network.
//
// Privacy note: this module never logs request bodies; server.ts logs only
// metadata (chat id, command, outcome).

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** A Telegram API call failed. `status` is the HTTP status when the API answered. */
export class TelegramError extends Error {
  readonly status?: number;
  readonly description?: string;
  constructor(message: string, opts: { status?: number; description?: string } = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = opts.status;
    this.description = opts.description;
  }
}

/** 409 Conflict: another consumer is polling (or webhook is set) for this token. */
export class TelegramConflictError extends TelegramError {
  constructor(description?: string) {
    super("Telegram API 409 Conflict: another consumer holds this bot token", {
      status: 409,
      description,
    });
    this.name = "TelegramConflictError";
  }
}

/** 429 Too Many Requests: `retryAfterSeconds` comes from the API's retry_after. */
export class TelegramRateLimitError extends TelegramError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, description?: string) {
    super(`Telegram API 429 Too Many Requests (retry after ${retryAfterSeconds}s)`, {
      status: 429,
      description,
    });
    this.name = "TelegramRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never got an answer (network/timeout/DNS). */
export class TelegramNetworkError extends TelegramError {
  constructor(cause: unknown) {
    super(
      `Telegram API unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TelegramNetworkError";
  }
}

export interface TelegramApi {
  getMe(token: string): Promise<TelegramMe>;
  getUpdates(
    token: string,
    opts: { offset?: number; limit?: number; timeoutSeconds?: number },
  ): Promise<TelegramUpdate[]>;
  sendMessage(
    token: string,
    chatId: number,
    text: string,
    opts?: { parseMode?: "Markdown"; replyMarkup?: TelegramReplyMarkup },
  ): Promise<{ messageId: number }>;
  answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string,
  ): Promise<void>;
  editMessageText(
    token: string,
    chatId: number,
    messageId: number,
    text: string,
    opts?: { replyMarkup?: TelegramReplyMarkup },
  ): Promise<void>;
}

export interface TelegramMe {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface CreateTelegramApiOptions {
  /** Injectable fetch (tests stub it). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export function createTelegramApi(options: CreateTelegramApiOptions = {}): TelegramApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBase ?? TELEGRAM_API_BASE;

  async function call<T>(
    token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (cause) {
      throw new TelegramNetworkError(cause);
    }

    let envelope: TelegramApiEnvelope<T>;
    try {
      envelope = (await response.json()) as TelegramApiEnvelope<T>;
    } catch {
      throw new TelegramError(`Telegram API ${method}: invalid JSON response (HTTP ${response.status})`, {
        status: response.status,
      });
    }

    if (!response.ok || !envelope.ok) {
      const description = envelope.description ?? `HTTP ${response.status}`;
      if (response.status === 409) throw new TelegramConflictError(description);
      if (response.status === 429) {
        const retryAfter =
          typeof envelope.parameters?.retry_after === "number"
            ? envelope.parameters.retry_after
            : 5;
        throw new TelegramRateLimitError(retryAfter, description);
      }
      if (!response.ok) {
        throw new TelegramError(`Telegram API ${method} failed: ${description}`, {
          status: response.status,
          description,
        });
      }
      // response.ok but ok=false (e.g. a 200-wrapped error): treat as a
      // generic API error; no special retry semantics.
      throw new TelegramError(`Telegram API ${method} failed: ${description}`, {
        description,
      });
    }

    return envelope.result as T;
  }

  return {
    getMe: (token) => call<TelegramMe>(token, "getMe"),
    getUpdates: (token, opts) =>
      call<TelegramUpdate[]>(token, "getUpdates", {
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 100,
        timeout: opts.timeoutSeconds ?? 10,
      }),
    sendMessage: (token, chatId, text, opts) =>
      call<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text,
        ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }).then((result) => ({ messageId: result.message_id })),
    answerCallbackQuery: (token, callbackQueryId, text) =>
      call<unknown>(token, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }).then(() => undefined),
    editMessageText: (token, chatId, messageId, text, opts) =>
      call<unknown>(token, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }).then(() => undefined),
  };
}
