import { supabase } from "@/integrations/supabase/client";
import { signedInProfileId } from "@/lib/remote-store";

export type CallKind = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "declined" | "missed";

export interface CallRow {
  id: string;
  caller_id: string;
  callee_id: string;
  kind: CallKind;
  status: CallStatus;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
}

export async function createCall(calleeId: string, kind: CallKind): Promise<CallRow | null> {
  const me = signedInProfileId();
  if (!me) return null;
  const { data, error } = await supabase
    .from("calls")
    .insert({ caller_id: me, callee_id: calleeId, kind, status: "ringing" })
    .select()
    .single();
  if (error) throw error;
  return data as unknown as CallRow;
}

/**
 * Transitions are guarded on the current status so a late click can never
 * resurrect a call that already ended, and the boolean tells the UI whether
 * the transition it requested actually won the race (e.g. answering a call the
 * caller already cancelled should stop the ring instead of joining a dead room).
 */
export async function answerCall(callId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("calls")
    .update({ status: "active", answered_at: new Date().toISOString() })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("id");
  if (error) console.error("answerCall write failed:", error.message);
  return (data?.length ?? 0) > 0;
}

export async function declineCall(callId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("calls")
    .update({ status: "declined", ended_at: new Date().toISOString() })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("id");
  if (error) console.error("declineCall write failed:", error.message);
  return (data?.length ?? 0) > 0;
}

export async function endCall(callId: string, seconds: number) {
  const { error } = await supabase
    .from("calls")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      duration_seconds: Math.max(0, Math.round(seconds)),
    })
    .eq("id", callId)
    .in("status", ["ringing", "active"]);
  // Guarded on the current status, so this is a no-op for a call that already
  // finished — but a rejected write leaves the row `ringing` forever, so say so.
  if (error) console.error("endCall failed:", error.message);
}

/** Fires whenever someone starts ringing this device's signed-in user. */
export function subscribeIncomingCalls(onIncoming: (call: CallRow) => void) {
  const me = signedInProfileId();
  if (!me) return () => {};

  const channel = supabase
    .channel(`incoming-calls-${me}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "calls", filter: `callee_id=eq.${me}` },
      (payload) => {
        const row = payload.new as unknown as CallRow;
        if (row.status === "ringing") onIncoming(row);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/** Fires on any status change for one call (answered, declined, ended). */
export function subscribeCallStatus(callId: string, onChange: (call: CallRow) => void) {
  const channel = supabase
    .channel(`call-status-${callId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${callId}` },
      (payload) => onChange(payload.new as unknown as CallRow),
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export async function markCallMissed(callId: string): Promise<boolean> {
  // Guarded on "ringing": the caller's timeout must never flip a call the
  // callee already picked up over to "missed". A rejected write answers the
  // same way as a lost race — `false` — so log it, or a caller that rings on
  // forever looks like a call somebody else already resolved.
  const { data, error } = await supabase
    .from("calls")
    .update({ status: "missed", ended_at: new Date().toISOString() })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("id");
  if (error) console.error("markCallMissed write failed:", error.message);
  return (data?.length ?? 0) > 0;
}

/** A call that started ringing for us moments ago, recovered after a refresh. */
export async function getPendingIncomingCall(): Promise<CallRow | null> {
  const me = signedInProfileId();
  if (!me) return null;
  const cutoff = new Date(Date.now() - 45_000).toISOString();
  const { data } = await supabase
    .from("calls")
    .select("*")
    .eq("callee_id", me)
    .eq("status", "ringing")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as unknown as CallRow) || null;
}
