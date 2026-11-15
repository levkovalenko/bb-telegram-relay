// Browser-safe contract surface for the management panel (app.tsx).
//
// This module lives in the app bundle's import graph and must stay free of
// server-only code: no `defineRpcContract`, no sqlite, no poller — constants
// and plain types only. The authoritative contract (zod schemas) lives in
// server.ts; the shapes below mirror its inputs/outputs.

/** Realtime channel the server publishes after channel/subscription changes. */
export const CHANGED_CHANNEL = "telegram-relay-changed";

/** Valid `level` values for a broadcast (RPC `broadcast` input). */
export const DELIVERY_LEVELS = ["info", "warning", "critical"] as const;
export type DeliveryLevel = (typeof DELIVERY_LEVELS)[number];

export type PollerState = "idle" | "polling" | "disabled" | "conflict";

/** RPC `status` output. */
export interface RelayStatus {
  state: PollerState;
  lastUpdateAt: string | null;
  lastError: string | null;
  configured: boolean;
}

/** One row of the RPC `channels` output. */
export interface RelayChannel {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  subscribers: number;
}

/** RPC `channels` output. */
export interface RelayChannels {
  channels: RelayChannel[];
  subscribers: number;
}

/** One row of the RPC `listSubscribers` output. */
export interface RelaySubscriber {
  chat_id: number;
  tg_username: string | null;
  channel_id: string;
  subscribed_at: string;
  last_seen_at: string | null;
}

/** One failed recipient inside an RPC `listDeliveries` row. */
export interface RelayDeliveryError {
  chat_id: number;
  code: number | "network" | "unknown";
  description: string;
}

/** One row of the RPC `listDeliveries` output (metadata only — no bodies). */
export interface RelayDelivery {
  id: number;
  channel: string;
  title: string;
  level: string;
  sent: number;
  failed: number;
  errors: RelayDeliveryError[];
  created_at: string;
}

/** RPC `broadcast` output. */
export interface RelayBroadcastResult {
  logId: number;
  sent: number;
  failed: number;
}
