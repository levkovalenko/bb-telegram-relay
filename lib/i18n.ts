// Tiny i18n for Telegram Relay: bot messages and the (future) panel.
//
// Two locales (en, ru). For bot replies the locale is picked per message from
// the Telegram user's language_code (Russian users get Russian, everyone else
// gets English). Strings live in one place so adding a locale is a matter of
// adding one dictionary below.

export type Locale = "en" | "ru";

export const en = {
  "bot.welcome":
    "Hi! You are now subscribed to the “{channel}” channel.\n\n" +
    "Use /channels to manage subscriptions, /help for all commands.",
  "bot.startNoDefault":
    "Welcome! No channels exist yet — the owner can create one with /admin. " +
    "We created the “general” channel and subscribed you to it.",
  "bot.channelsTitle": "Pick your channels (tap to subscribe / unsubscribe):",
  "bot.channelsEmpty": "No channels yet. The owner creates them with /admin.",
  "bot.channelSubscribed": "Subscribed to “{channel}”",
  "bot.channelUnsubscribed": "Unsubscribed from “{channel}”",
  "bot.help":
    "Commands:\n" +
    "/start — subscribe to the default channel\n" +
    "/channels — manage your subscriptions\n" +
    "/help — this help\n" +
    "/admin — owner-only channel management",
  "bot.unknownCommand": "Unknown command. Use /help.",
  "bot.plainTextHint": "I only understand /commands. Try /help.",
  "bot.adminUsage":
    "Owner commands:\n" +
    "/admin list — list channels\n" +
    "/admin create <id> [name...] — create a channel\n" +
    "/admin setdefault <id> — make a channel the default\n" +
    "/admin delete <id> — delete a channel and its subscriptions\n" +
    "/admin subs [channel] — list subscribers",
  "bot.adminForbidden": "Only the owner can use /admin.",
  "bot.adminCreated": "Channel “{id}” created.",
  "bot.adminCreatedDefault":
    "Channel “{id}” created (it is the default one, since no other channels existed).",
  "bot.adminExists": "Channel “{id}” already exists.",
  "bot.adminBadId":
    "Channel ids use 1–64 lowercase letters, digits or dashes, starting with a letter or digit.",
  "bot.adminDeleted": "Channel “{id}” deleted with its subscriptions.",
  "bot.adminMissing": "No channel “{id}”.",
  "bot.adminDefaultSet": "“{id}” is now the default channel.",
  "bot.adminList": "Channels:",
  "bot.adminListEmpty": "No channels yet — create one: /admin create <id> [name]",
  "bot.adminListRow": "• {id} — {name} ({count} subscriber(s))",
  "bot.adminListDefault": "(default)",
  "bot.adminSubs": "Subscribers of “{channel}”:",
  "bot.adminSubsAll": "All subscribers:",
  "bot.adminSubsRow": "• {username} (chat {chatId})",
  "bot.adminSubsEmpty": "No subscribers.",
  "settings.botToken": "Bot token",
  "settings.botToken.desc":
    "Token of the Telegram bot (from @BotFather). Stored as a secret: 0600 file on disk, never in the database or the frontend.",
  "settings.ownerChatId": "Owner chat id",
  "settings.ownerChatId.desc":
    "Numeric Telegram chat id of the plugin owner; only this chat may use /admin.",
  "settings.enabled": "Polling enabled",
  "settings.enabled.desc":
    "Start long polling for incoming bot messages when the plugin loads.",
  "settings.pollTimeout": "Poll timeout (seconds)",
  "settings.pollTimeout.desc": "Long-poll wait time per getUpdates call, 1–30 seconds.",
  "panel.title": "Telegram relay",
  "panel.subtitle":
    "Multi-user Telegram relay for team notifications: channels, subscribers and the broadcast journal.",
  "panel.state.polling": "polling",
  "panel.state.idle": "idle",
  "panel.state.disabled": "disabled",
  "panel.state.conflict": "stopped: another consumer holds the token (409)",
  "panel.state.needsConfiguration": "not configured (set the bot token)",
  "panel.meta": "{channels} channels · {subscribers} subscribers",
  "panel.sectionStatus": "Poller status",
  "panel.lastUpdate": "Last update",
  "panel.lastError": "Last error",
  "panel.never": "never",
  "panel.notConfigured": "Not configured — set the bot token in plugin settings.",
  "panel.loading": "Loading…",
  "panel.loadError": "Failed to load panel data: {error}",
  "panel.refresh": "Refresh",
  "panel.lang": "Language",
  "panel.langAuto": "Auto (browser)",
  "panel.sectionChannels": "Channels",
  "panel.default": "(default)",
  "panel.channelsEmpty":
    "No channels yet — create one: bb telegram-relay channel create <id>",
  "panel.sectionSubscribers": "Subscribers",
  "panel.subscribersEmpty": "No subscribers yet — users subscribe through the bot.",
  "panel.colChat": "Chat",
  "panel.colUser": "User",
  "panel.colChannel": "Channel",
  "panel.colSubscribed": "Subscribed",
  "panel.colLastSeen": "Last seen",
  "panel.sectionJournal": "Delivery journal",
  "panel.journalEmpty": "No deliveries logged yet.",
  "panel.journalColTime": "Time",
  "panel.journalColLevel": "Level",
  "panel.journalColChannel": "Channels",
  "panel.journalColTitle": "Title",
  "panel.journalColResult": "Result",
  "panel.journalErrors": "{n} failed recipient(s)",
  "panel.sectionBroadcast": "Test broadcast",
  "panel.broadcastHint":
    "Sends a real message to the subscribers of the chosen channels.",
  "panel.fieldTitle": "Title",
  "panel.fieldTitlePh": "e.g. Deploy finished",
  "panel.fieldBody": "Body",
  "panel.fieldBodyPh": "e.g. build 42 is out",
  "panel.fieldChannels": "Channels",
  "panel.fieldLevel": "Level",
  "panel.send": "Send",
  "panel.sending": "Sending…",
  "panel.bcNeedTitle": "Give the broadcast a title.",
  "panel.bcNeedChannels": "Pick at least one channel.",
  "panel.bcResult":
    "Broadcast done: {sent} sent, {failed} failed (journal entry #{logId}).",
} as const;

export const ru = {
  "bot.welcome":
    "Привет! Ты подписался на канал «{channel}».\n\n" +
    "Управляй подписками: /channels, все команды: /help.",
  "bot.startNoDefault":
    "Привет! Каналов ещё нет — владелец создаёт их через /admin. " +
    "Мы создали канал «general» и подписали тебя на него.",
  "bot.channelsTitle": "Выбери каналы (тап = подписка / отписка):",
  "bot.channelsEmpty": "Каналов пока нет. Владелец создаёт их через /admin.",
  "bot.channelSubscribed": "Подписка на «{channel}» оформлена",
  "bot.channelUnsubscribed": "Подписка на «{channel}» снята",
  "bot.help":
    "Команды:\n" +
    "/start — подписка на канал по умолчанию\n" +
    "/channels — управление подписками\n" +
    "/help — эта справка\n" +
    "/admin — управление каналами (только владелец)",
  "bot.unknownCommand": "Неизвестная команда. Открой /help.",
  "bot.plainTextHint": "Я понимаю только /команды. Попробуй /help.",
  "bot.adminUsage":
    "Команды владельца:\n" +
    "/admin list — список каналов\n" +
    "/admin create <id> [название...] — создать канал\n" +
    "/admin setdefault <id> — сделать канал каналом по умолчанию\n" +
    "/admin delete <id> — удалить канал вместе с подписками\n" +
    "/admin subs [канал] — список подписчиков",
  "bot.adminForbidden": "/admin доступен только владельцу.",
  "bot.adminCreated": "Канал «{id}» создан.",
  "bot.adminCreatedDefault":
    "Канал «{id}» создан (это канал по умолчанию, так как других каналов не было).",
  "bot.adminExists": "Канал «{id}» уже существует.",
  "bot.adminBadId":
    "Идентификаторы каналов: 1–64 символа, строчные буквы, цифры и дефис, начинается с буквы или цифры.",
  "bot.adminDeleted": "Канал «{id}» удалён вместе с подписками.",
  "bot.adminMissing": "Нет канала «{id}».",
  "bot.adminDefaultSet": "Канал «{id}» теперь по умолчанию.",
  "bot.adminList": "Каналы:",
  "bot.adminListEmpty": "Каналов пока нет — создай: /admin create <id> [название]",
  "bot.adminListRow": "• {id} — {name} ({count} подписчик(ов))",
  "bot.adminListDefault": "(по умолчанию)",
  "bot.adminSubs": "Подписчики «{channel}»:",
  "bot.adminSubsAll": "Все подписчики:",
  "bot.adminSubsRow": "• {username} (чат {chatId})",
  "bot.adminSubsEmpty": "Подписчиков нет.",
  "settings.botToken": "Токен бота",
  "settings.botToken.desc":
    "Токен Telegram-бота (от @BotFather). Хранится как секрет: файл 0600 на диске, никогда не попадает в базу и во фронтенд.",
  "settings.ownerChatId": "Chat id владельца",
  "settings.ownerChatId.desc":
    "Числовой Telegram chat id владельца плагина; только этот чат может использовать /admin.",
  "settings.enabled": "Опрос включён",
  "settings.enabled.desc":
    "Запускать long polling входящих сообщений бота при загрузке плагина.",
  "settings.pollTimeout": "Таймаут опроса (секунды)",
  "settings.pollTimeout.desc":
    "Время ожидания long-poll каждого вызова getUpdates, 1–30 секунд.",
  "panel.title": "Telegram relay",
  "panel.subtitle":
    "Мультипользовательский Telegram-релей: каналы, подписчики и журнал рассылок.",
  "panel.state.polling": "опрос идёт",
  "panel.state.idle": "простой",
  "panel.state.disabled": "выключено",
  "panel.state.conflict": "остановлено: токен занят другим потребителем (409)",
  "panel.state.needsConfiguration": "не настроено (укажите токен бота)",
  "panel.meta": "каналов: {channels} · подписчиков: {subscribers}",
  "panel.sectionStatus": "Статус опроса",
  "panel.lastUpdate": "Последнее обновление",
  "panel.lastError": "Последняя ошибка",
  "panel.never": "никогда",
  "panel.notConfigured": "Не настроено — укажите токен бота в настройках плагина.",
  "panel.loading": "Загрузка…",
  "panel.loadError": "Не удалось загрузить данные: {error}",
  "panel.refresh": "Обновить",
  "panel.lang": "Язык",
  "panel.langAuto": "Авто (браузер)",
  "panel.sectionChannels": "Каналы",
  "panel.default": "(по умолчанию)",
  "panel.channelsEmpty":
    "Каналов пока нет — создайте: bb telegram-relay channel create <id>",
  "panel.sectionSubscribers": "Подписчики",
  "panel.subscribersEmpty": "Подписчиков пока нет — подписываются через бота.",
  "panel.colChat": "Чат",
  "panel.colUser": "Пользователь",
  "panel.colChannel": "Канал",
  "panel.colSubscribed": "Подписан(а)",
  "panel.colLastSeen": "Последний вход",
  "panel.sectionJournal": "Журнал доставок",
  "panel.journalEmpty": "Записей о доставках пока нет.",
  "panel.journalColTime": "Время",
  "panel.journalColLevel": "Уровень",
  "panel.journalColChannel": "Каналы",
  "panel.journalColTitle": "Заголовок",
  "panel.journalColResult": "Результат",
  "panel.journalErrors": "{n} получатель(ей) с ошибкой",
  "panel.sectionBroadcast": "Тестовая рассылка",
  "panel.broadcastHint":
    "Отправит реальное сообщение подписчикам выбранных каналов.",
  "panel.fieldTitle": "Заголовок",
  "panel.fieldTitlePh": "напр. Deploy finished",
  "panel.fieldBody": "Текст",
  "panel.fieldBodyPh": "напр. build 42 is out",
  "panel.fieldChannels": "Каналы",
  "panel.fieldLevel": "Уровень",
  "panel.send": "Отправить",
  "panel.sending": "Отправка…",
  "panel.bcNeedTitle": "Укажите заголовок рассылки.",
  "panel.bcNeedChannels": "Выберите хотя бы один канал.",
  "panel.bcResult":
    "Готово: {sent} доставлено, {failed} с ошибкой (запись журнала #{logId}).",
} as const;

export type MessageKey = keyof typeof en;
/** Same keys as `en`, values widened to string (ru has its own literals). */
export type Messages = { [K in MessageKey]: string };

const DICT: Record<Locale, Messages> = { en, ru };

/** Pick the locale from a Telegram user's language_code (may be missing). */
export function localeFromLanguageCode(languageCode?: string | null): Locale {
  return languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/**
 * Best-effort host locale for settings labels rendered at plugin load:
 * navigator.language when available (browser), otherwise English.
 */
export function detectLocale(): Locale {
  try {
    const nav =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language
        : "en";
    return nav.toLowerCase().startsWith("ru") ? "ru" : "en";
  } catch {
    return "en";
  }
}

/**
 * Translate one key with optional {placeholders}. Falls back to the English
 * dictionary, then to the key itself, so a missing string is visible instead
 * of blank.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  let text: string = DICT[locale][key] ?? DICT.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
