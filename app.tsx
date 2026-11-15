// bb-plugin-telegram-relay — frontend entry (M3): the management panel.
//
// One project nav panel ("Telegram relay"), bilingual (en/ru):
//   - poller status (state, last update, last error) — RPC `status`;
//   - channels with default mark and subscriber counts — RPC `channels`;
//   - subscribers table — RPC `listSubscribers`;
//   - the recent delivery journal (metadata only) — RPC `listDeliveries`;
//   - a test-broadcast form — RPC `broadcast`.
// Data refreshes on the `telegram-relay-changed` realtime signal (channels /
// subscriptions / auto-unsubscribes) and on the manual Refresh button; after
// a broadcast the whole panel re-reads, so the journal and subscriber counts
// are current.
//
// Browser-safe contract (the tasks-kanban lesson): only a TYPE import from
// server.ts — it is erased at build, so no server code (defineRpcContract,
// sqlite, the poller) ever reaches the app bundle. Value constants and the
// contract shapes live in the browser-safe lib/panel.ts; i18n in lib/i18n.ts.
//
// React and @get-bb/plugin-sdk/app are provided by the BB host at load time
// (never bundled), so this file must be loaded by BB, not imported directly.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
// Type-only import: the inferred contract types are erased at build time,
// so the app bundle never reaches the server implementation.
import type { rpcContract } from "./server";
import {
  CHANGED_CHANNEL,
  DELIVERY_LEVELS,
  type DeliveryLevel,
  type RelayBroadcastResult,
  type RelayChannels,
  type RelayDelivery,
  type RelayStatus,
  type RelaySubscriber,
} from "./lib/panel";
import {
  detectLocale,
  translate,
  type Locale,
  type MessageKey,
} from "./lib/i18n";

// UI locale: auto (browser language) or an explicit ru/en pick, tasks-kanban
// style; the pick is session-local (the plugin has no panel settings).
type UiLang = "auto" | Locale;
type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

const inputCls =
  "h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-primary/60";
const selectCls =
  "h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-primary/60";
const sectionCls = "rounded-md border p-3";
const sectionTitleCls =
  "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

const STATE_DOT: Record<RelayStatus["state"], string> = {
  polling: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
  disabled: "bg-amber-500",
  conflict: "bg-destructive",
};

const LEVEL_TONE: Record<string, string> = {
  info: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-400",
  warning:
    "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  critical: "border-destructive/30 bg-destructive/15 text-destructive",
};

function msg(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** "2026-11-15T12:34:56.789Z" -> "2026-11-15 12:34:56 UTC" (UTC throughout). */
function fmtTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function useRelay() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [channels, setChannels] = useState<RelayChannels | null>(null);
  const [subscribers, setSubscribers] = useState<RelaySubscriber[] | null>(null);
  const [deliveries, setDeliveries] = useState<RelayDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void Promise.allSettled([
      rpc.call("status", null).then(setStatus),
      rpc.call("channels", null).then(setChannels),
      rpc.call("listSubscribers", {}).then(setSubscribers),
      rpc.call("listDeliveries", { limit: 50 }).then(setDeliveries),
    ]).then((results) => {
      const failed = results.find((r) => r.status === "rejected");
      setError(failed && failed.status === "rejected" ? msg(failed.reason) : null);
    });
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // The server publishes after channel/subscription changes (bot commands,
  // CLI, auto-unsubscribe) — keep the panel fresh without polling.
  useRealtime(CHANGED_CHANNEL, refresh);

  return { status, channels, subscribers, deliveries, error, refresh };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={sectionCls}>
      <h2 className={sectionTitleCls}>{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function StatusSection({ status, t }: { status: RelayStatus | null; t: TFn }) {
  return (
    <Section title={t("panel.sectionStatus")}>
      {status === null ? (
        <p className="text-sm text-muted-foreground">{t("panel.loading")}</p>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block size-2 rounded-full ${STATE_DOT[status.state]}`}
            />
            <span className="font-medium">{t(`panel.state.${status.state}`)}</span>
          </p>
          <p className="text-muted-foreground">
            {t("panel.lastUpdate")}: {status.lastUpdateAt ? fmtTime(status.lastUpdateAt) : t("panel.never")}
          </p>
          {status.lastError ? (
            <p className="break-words text-destructive">
              {t("panel.lastError")}: {status.lastError}
            </p>
          ) : null}
          {!status.configured ? (
            <p className="text-amber-600 dark:text-amber-400">{t("panel.notConfigured")}</p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function ChannelsSection({ channels, t }: { channels: RelayChannels | null; t: TFn }) {
  return (
    <Section title={t("panel.sectionChannels")}>
      {channels === null ? (
        <p className="text-sm text-muted-foreground">{t("panel.loading")}</p>
      ) : channels.channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.channelsEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {channels.channels.map((channel) => (
            <li key={channel.id} className="text-sm">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{channel.name}</span>
                <code className="rounded bg-muted px-1 font-mono text-xs text-muted-foreground">
                  {channel.id}
                </code>
                {channel.isDefault ? (
                  <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] text-primary">
                    {t("panel.default")}
                  </span>
                ) : null}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {channel.subscribers}
                </span>
              </p>
              {channel.description ? (
                <p className="text-xs text-muted-foreground">{channel.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const thCls = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const tdCls = "px-2 py-1.5 align-top";

function SubscribersSection({ subscribers, t }: { subscribers: RelaySubscriber[] | null; t: TFn }) {
  return (
    <Section title={t("panel.sectionSubscribers")}>
      {subscribers === null ? (
        <p className="text-sm text-muted-foreground">{t("panel.loading")}</p>
      ) : subscribers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.subscribersEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={thCls}>{t("panel.colChat")}</th>
                <th className={thCls}>{t("panel.colUser")}</th>
                <th className={thCls}>{t("panel.colChannel")}</th>
                <th className={thCls}>{t("panel.colSubscribed")}</th>
                <th className={thCls}>{t("panel.colLastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((row) => (
                <tr
                  key={`${row.chat_id}:${row.channel_id}`}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className={`${tdCls} font-mono text-xs tabular-nums`}>{row.chat_id}</td>
                  <td className={tdCls}>{row.tg_username ? `@${row.tg_username}` : "—"}</td>
                  <td className={tdCls}>
                    <code className="rounded bg-muted px-1 font-mono text-xs">
                      {row.channel_id}
                    </code>
                  </td>
                  <td className={`${tdCls} whitespace-nowrap text-xs text-muted-foreground`}>
                    {fmtTime(row.subscribed_at)}
                  </td>
                  <td className={`${tdCls} whitespace-nowrap text-xs text-muted-foreground`}>
                    {row.last_seen_at ? fmtTime(row.last_seen_at) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function JournalSection({ deliveries, t }: { deliveries: RelayDelivery[] | null; t: TFn }) {
  return (
    <Section title={t("panel.sectionJournal")}>
      {deliveries === null ? (
        <p className="text-sm text-muted-foreground">{t("panel.loading")}</p>
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.journalEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {deliveries.map((row) => (
            <li key={row.id} className="rounded-md bg-muted/40 p-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {fmtTime(row.created_at)}
                </span>
                <span
                  className={`rounded border px-1.5 py-px text-[10px] font-medium ${
                    LEVEL_TONE[row.level] ?? "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  {row.level}
                </span>
                <code className="rounded bg-muted px-1 font-mono text-xs text-muted-foreground">
                  {row.channel}
                </code>
                <span className="min-w-0 flex-1 truncate font-medium" title={row.title}>
                  {row.title}
                </span>
                <span className="text-xs tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">{row.sent} ✓</span>
                  {row.failed > 0 ? (
                    <span className="text-destructive"> · {row.failed} ✗</span>
                  ) : (
                    <span className="text-muted-foreground"> · 0 ✗</span>
                  )}
                </span>
              </div>
              {row.errors.length > 0 ? (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-destructive">
                    {t("panel.journalErrors", { n: row.errors.length })}
                  </summary>
                  <ul className="mt-1 space-y-0.5 break-words text-muted-foreground">
                    {row.errors.map((err) => (
                      <li key={`${row.id}:${err.chat_id}`}>
                        <span className="font-mono tabular-nums">chat {err.chat_id}</span>{" "}
                        [{err.code}] {err.description}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function BroadcastForm({
  channels,
  t,
  onSent,
}: {
  channels: RelayChannels | null;
  t: TFn;
  onSent: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [level, setLevel] = useState<DeliveryLevel>("info");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelayBroadcastResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const list = channels?.channels ?? [];
  // Channels may disappear (auto-unsubscribe of the last subscriber does not,
  // but the owner can delete one) — keep only ids that still exist.
  const validSelected = selected.filter((id) => list.some((c) => c.id === id));

  const toggle = (id: string) => {
    setResult(null);
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const send = async () => {
    if (title.trim() === "") {
      setFormError(t("panel.bcNeedTitle"));
      return;
    }
    if (validSelected.length === 0) {
      setFormError(t("panel.bcNeedChannels"));
      return;
    }
    setBusy(true);
    setFormError(null);
    setResult(null);
    try {
      const res = await rpc.call("broadcast", {
        title: title.trim(),
        body,
        channels: validSelected,
        level,
      });
      setResult(res);
      setTitle("");
      setBody("");
      // Re-read the journal (and subscriber counts, in case of an
      // auto-unsubscribe) after the broadcast.
      onSent();
    } catch (cause) {
      setFormError(msg(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("panel.sectionBroadcast")}>
      <p className="text-xs text-muted-foreground">{t("panel.broadcastHint")}</p>
      <div className="mt-2 space-y-2">
        <label className="block">
          <span className="text-xs text-muted-foreground">{t("panel.fieldTitle")}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("panel.fieldTitlePh")}
            className={`${inputCls} mt-0.5`}
            aria-label={t("panel.fieldTitle")}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">{t("panel.fieldBody")}</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("panel.fieldBodyPh")}
            rows={3}
            className={`${inputCls} mt-0.5 h-auto py-1.5`}
            aria-label={t("panel.fieldBody")}
          />
        </label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">{t("panel.fieldChannels")}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {list.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t("panel.channelsEmpty")}</span>
              ) : null}
              {list.map((channel) => {
                const active = validSelected.includes(channel.id);
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => toggle(channel.id)}
                    className={`rounded-full border px-2 py-px text-[11px] ${
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {channel.id}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t("panel.fieldLevel")}</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as DeliveryLevel)}
              className={selectCls}
              aria-label={t("panel.fieldLevel")}
            >
              {DELIVERY_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || channels === null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
          >
            {busy ? t("panel.sending") : t("panel.send")}
          </button>
          {result !== null ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("panel.bcResult", {
                sent: result.sent,
                failed: result.failed,
                logId: result.logId,
              })}
            </span>
          ) : null}
        </div>
        {formError ? (
          <p role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function RelayPanel({
  lang,
  setLang,
}: {
  lang: UiLang;
  setLang: (lang: UiLang) => void;
}) {
  const { status, channels, subscribers, deliveries, error, refresh } = useRelay();
  const locale: Locale = lang === "auto" ? detectLocale() : lang;
  const t = useCallback<TFn>(
    (key, vars) => translate(locale, key, vars),
    [locale],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-semibold">{t("panel.title")}</h1>
        {channels !== null ? (
          <span className="text-xs text-muted-foreground">
            {t("panel.meta", {
              channels: channels.channels.length,
              subscribers: channels.subscribers,
            })}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as UiLang)}
            className={selectCls}
            aria-label={t("panel.lang")}
          >
            <option value="auto">{t("panel.langAuto")}</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
          <button
            type="button"
            onClick={refresh}
            title={t("panel.refresh")}
            aria-label={t("panel.refresh")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:border-primary/40 hover:text-foreground"
          >
            ⟳ {t("panel.refresh")}
          </button>
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {t("panel.loadError", { error })}
        </p>
      ) : null}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs text-muted-foreground">{t("panel.subtitle")}</p>
        <StatusSection status={status} t={t} />
        <ChannelsSection channels={channels} t={t} />
        <SubscribersSection subscribers={subscribers} t={t} />
        <JournalSection deliveries={deliveries} t={t} />
        <BroadcastForm channels={channels} t={t} onSent={refresh} />
      </div>
    </div>
  );
}

function RelayPanelRoot() {
  const [lang, setLang] = useState<UiLang>("auto");
  return <RelayPanel lang={lang} setLang={setLang} />;
}

// The default export must be definePluginApp(...). navPanel adds the page to
// the left navigation — visible for the whole project, any thread, any device.
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "relay",
    // Panel label from the browser locale (slot registration is static);
    // the panel content follows the in-panel language picker.
    title: translate(detectLocale(), "panel.title"),
    icon: "Send",
    path: "relay",
    component: RelayPanelRoot,
  });
});
