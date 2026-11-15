// bb-plugin-telegram-relay — frontend entry (M1 stub).
//
// The management UI lands in M3; this stub only proves the browser-safe
// contract: it imports the RPC contract from server.ts as a TYPE (erased at
// build — no server code reaches the bundle) and shows the live poller state.
//
// React and @get-bb/plugin-sdk/app are provided by the BB host at load time
// (never bundled), so this file must be loaded by BB, not imported directly.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

interface RelayStatus {
  state: "idle" | "polling" | "disabled" | "conflict";
  lastUpdateAt: string | null;
  lastError: string | null;
  configured: boolean;
}

interface RelayChannels {
  channels: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    subscribers: number;
  }>;
  subscribers: number;
}

function StatusView() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [channels, setChannels] = useState<RelayChannels | null>(null);

  const refresh = () => {
    void rpc
      .call("status", null)
      .then(setStatus)
      .catch(() => setStatus(null));
    void rpc
      .call("channels", null)
      .then(setChannels)
      .catch(() => setChannels(null));
  };

  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime("telegram-relay-changed", refresh);

  const stateLabel: Record<RelayStatus["state"], string> = {
    polling: "polling",
    idle: "idle",
    disabled: "disabled",
    conflict: "conflict (409)",
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p className="text-muted-foreground">
        Multi-user Telegram relay for team notifications.
      </p>
      <div className="rounded-md border p-3">
        <p className="font-medium">
          Poller:{" "}
          {status ? (
            <span>{stateLabel[status.state]}</span>
          ) : (
            <span className="text-muted-foreground">unknown</span>
          )}
        </p>
        {status && !status.configured && (
          <p className="text-muted-foreground">
            Not configured — set the bot token in plugin settings.
          </p>
        )}
        {status?.lastUpdateAt && (
          <p className="text-muted-foreground">Last update: {status.lastUpdateAt}</p>
        )}
        {status?.lastError && <p className="text-destructive">{status.lastError}</p>}
      </div>
      {channels && (
        <div className="rounded-md border p-3">
          <p className="font-medium">
            {channels.channels.length} channels · {channels.subscribers} subscribers
          </p>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {channels.channels.map((channel) => (
              <li key={channel.id}>
                {channel.id} — {channel.name}
                {channel.isDefault ? " (default)" : ""} · {channel.subscribers}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Management UI arrives in M3; for now use the bot and{" "}
        <code className="rounded bg-muted px-1">bb telegram-relay</code>.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "relay",
    title: "Telegram relay",
    icon: "Send",
    path: "relay",
    component: StatusView,
  });
});
