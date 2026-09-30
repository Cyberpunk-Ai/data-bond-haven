import { useEffect, useState } from "react";

import { createApiKey } from "@/lib/developer.functions";
import {
  deleteOwnedRow,
  insertOwnedRow,
  loadOwnedRows,
  signedInProfileId,
} from "@/lib/remote-store";

export interface ApiKey {
  id: string;
  name: string;
  maskedKey: string;
  fullKey?: string;
  createdAt: string;
  lastUsed: string;
  calls?: number;
}

export interface Webhook {
  id: string;
  url: string;
  description: string;
  events: string[];
  status: "active" | "paused";
  createdAt: string;
}

interface DeveloperState {
  apiKeys: ApiKey[];
  webhooks: Webhook[];
  totalApiCallsThisMonth: number;
}

const DEFAULTS: DeveloperState = { apiKeys: [], webhooks: [], totalApiCallsThisMonth: 0 };

// Keys and webhooks are only ever read from the database - never cached in the
// browser, so one account can never see another account's credentials.
let state: DeveloperState = DEFAULTS;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function commit(next: DeveloperState) {
  state = next;
  listeners.forEach((fn) => fn());
}

async function hydrate() {
  const userId = signedInProfileId();
  if (!userId) {
    loadedFor = null;
    if (state.apiKeys.length || state.webhooks.length) commit(DEFAULTS);
    return;
  }
  if (loadedFor === userId) return;
  loadedFor = userId;
  let calls = 0;
  const [apiKeys, webhooks] = await Promise.all([
    loadOwnedRows<ApiKey>("api_keys", (row) => ({
      id: String(row.id),
      name: String(row.name),
      maskedKey: `${row.prefix}••••••••${String(row.last4 ?? "")}`,
      createdAt: new Date(row.created_at).toLocaleDateString(),
      lastUsed: row.last_used_at ? new Date(row.last_used_at).toLocaleDateString() : "Never",
      calls: Number(row.call_count ?? 0),
    })),
    loadOwnedRows<Webhook>("webhooks", (row) => ({
      id: String(row.id),
      url: String(row.url),
      description: String(row.description ?? ""),
      // The signing secret is deliberately not read into browser state: nothing
      // in the UI verifies payloads, and a leaked secret lets a stranger forge
      // "signed" deliveries that the receiver would accept.
      events: Array.isArray(row.events) ? (row.events as string[]) : [],
      status: row.active ? "active" : "paused",
      createdAt: new Date(row.created_at).toLocaleDateString(),
    })),
  ]);
  calls = apiKeys.reduce((sum, k) => sum + (k.calls ?? 0), 0);
  commit({ apiKeys, webhooks, totalApiCallsThisMonth: calls });
}

export function useDeveloper() {
  const [snapshot, setSnapshot] = useState<DeveloperState>(state);

  useEffect(() => {
    const sync = () => setSnapshot({ ...state });
    listeners.add(sync);
    sync();
    void hydrate();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  async function generateApiKey(name: string): Promise<ApiKey> {
    const created = await createApiKey({ data: { name } });
    const key: ApiKey = {
      id: created.id,
      name,
      maskedKey: `sp1_live_••••••••${created.last4}`,
      fullKey: created.token,
      createdAt: new Date(created.createdAt).toLocaleDateString(),
      lastUsed: "Never",
      calls: 0,
    };
    commit({ ...state, apiKeys: [key, ...state.apiKeys] });
    return key;
  }

  async function revokeApiKey(id: string) {
    // Await the delete before touching local state: the old fire-and-forget
    // path dropped the key from the screen even when the row was still live,
    // so the key kept authenticating while the portal said it was revoked.
    await deleteOwnedRow("api_keys", id);
    commit({ ...state, apiKeys: state.apiKeys.filter((k) => k.id !== id) });
  }

  async function addWebhook(url: string, description: string, events: string[]) {
    // A failed insert must not add a ghost endpoint: the `webhooks_url_https`
    // CHECK and RLS both reject writes, and swallowing that left the portal
    // listing a URL that existed only in the browser.
    const row = await insertOwnedRow("webhooks", { url, events, active: true, description });
    if (!row?.id) throw new Error("We couldn't register that webhook endpoint.");
    const hook: Webhook = {
      id: String(row.id),
      url,
      description,
      events,
      status: "active",
      createdAt: new Date(row.created_at ?? Date.now()).toLocaleDateString(),
    };
    commit({ ...state, webhooks: [hook, ...state.webhooks] });
    return hook;
  }

  async function removeWebhook(id: string) {
    await deleteOwnedRow("webhooks", id);
    commit({ ...state, webhooks: state.webhooks.filter((w) => w.id !== id) });
  }

  return {
    apiKeys: snapshot.apiKeys,
    webhooks: snapshot.webhooks,
    totalApiCallsThisMonth: snapshot.totalApiCallsThisMonth,
    generateApiKey,
    revokeApiKey,
    addWebhook,
    removeWebhook,
  };
}
