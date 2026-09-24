/**
 * Small helpers that back the client-side feature stores with real rows in the
 * Lovable Cloud database. Each store keeps its instant, optimistic local state
 * and uses these helpers to hydrate once per session and write through.
 */
import { supabase } from "@/integrations/supabase/client";
import { currentUserId, subscribeProfiles } from "@/lib/profile-service";

const db = supabase as any;

export function signedInProfileId(): string | null {
  return currentUserId && currentUserId !== "guest" ? currentUserId : null;
}

/**
 * Syncs a single row (keyed by user_id) with local state.
 * `apply` receives the remote values; `push` upserts local values.
 */
export function attachRemoteRecord<T>(opts: {
  table: string;
  fromRow: (row: Record<string, any>) => Partial<T>;
  toRow: (state: T) => Record<string, unknown>;
  apply: (patch: Partial<T>) => void;
}) {
  let loadedFor: string | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  async function load() {
    const userId = signedInProfileId();
    if (!userId || loadedFor === userId) return;
    loadedFor = userId;
    const { data } = await db.from(opts.table).select("*").eq("user_id", userId).maybeSingle();
    if (data) opts.apply(opts.fromRow(data));
  }

  function push(state: T) {
    const userId = signedInProfileId();
    if (!userId) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      void db.from(opts.table).upsert({ user_id: userId, ...opts.toRow(state) });
    }, 250);
  }

  if (typeof window !== "undefined") {
    void load();
    subscribeProfiles(() => void load());
  }

  return { load, push };
}

/** Loads every row owned by the signed-in profile from a table. */
export async function loadOwnedRows<T>(
  table: string,
  map: (row: Record<string, any>) => T,
  order = "created_at",
): Promise<T[]> {
  const userId = signedInProfileId();
  if (!userId) return [];
  const { data } = await db
    .from(table)
    .select("*")
    .eq("user_id", userId)
    .order(order, { ascending: false });
  return ((data ?? []) as Record<string, any>[]).map(map);
}

export async function insertOwnedRow(table: string, values: Record<string, unknown>) {
  const userId = signedInProfileId();
  if (!userId) return null;
  const { data, error } = await db
    .from(table)
    .insert({ user_id: userId, ...values })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, any> | null;
}

export async function updateOwnedRow(table: string, id: string, patch: Record<string, unknown>) {
  const { error } = await db.from(table).update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteOwnedRow(table: string, id: string) {
  const { error } = await db.from(table).delete().eq("id", id);
  if (error) throw error;
}
