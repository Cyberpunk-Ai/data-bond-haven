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

export async function answerCall(callId: string) {
  await supabase
    .from("calls")
    .update({ status: "active", answered_at: new Date().toISOString() })
    .eq("id", callId);
}

export async function declineCall(callId: string) {
  await supabase
    .from("calls")
    .update({ status: "declined", ended_at: new Date().toISOString() })
    .eq("id", callId);
}

export async function endCall(callId: string, seconds: number) {
  await supabase
    .from("calls")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      duration_seconds: Math.max(0, Math.round(seconds)),
    })
    .eq("id", callId);
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
