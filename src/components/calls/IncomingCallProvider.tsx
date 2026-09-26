import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Phone, Video, X } from "lucide-react";
import { toast } from "sonner";

import { Avatar } from "@/components/social/Avatar";
import { CallModal } from "@/components/social/CallModal";
import { useAuth } from "@/lib/auth-state";
import {
  ensureNotificationsWorker,
  notificationsSupported,
  showSystemNotification,
} from "@/lib/browser-notifications";
import { useDesktopNotifications } from "@/hooks/useDesktopNotifications";
import { getPreferences } from "@/lib/preferences-state";
import { getUsers } from "@/lib/api-client";
import { ensurePresenceJoined } from "@/lib/presence";
import {
  answerCall,
  createCall,
  declineCall,
  endCall,
  getPendingIncomingCall,
  markCallMissed,
  subscribeCallStatus,
  subscribeIncomingCalls,
  type CallKind,
} from "@/lib/calls";
import type { Profile } from "@/lib/types";

const RING_TIMEOUT_MS = 45_000;

interface ActiveCallState {
  user: Profile;
  type: CallKind;
  callId: string | null;
  role: "caller" | "callee";
  status: "ringing" | "active";
}

interface IncomingCallState {
  user: Profile;
  type: CallKind;
  callId: string;
}

interface CallDialerContextValue {
  startCall: (user: Profile, type: CallKind) => void;
}

const CallDialerContext = createContext<CallDialerContextValue | null>(null);

/** Lets any screen ring another user without knowing about call plumbing. */
export function useCallDialer(): CallDialerContextValue {
  const ctx = useContext(CallDialerContext);
  if (!ctx) throw new Error("useCallDialer must be used within IncomingCallProvider");
  return ctx;
}

/** A gentle two-tone ringtone using WebAudio so no audio asset is needed. */
function startRingtone(): () => void {
  if (typeof window === "undefined") return () => {};
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  let stopped = false;

  function beep(freq: number, delay: number) {
    if (stopped) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.start(start);
    osc.stop(start + 0.45);
  }

  function ring() {
    beep(880, 0);
    beep(660, 0.5);
  }
  ring();
  const timer = setInterval(ring, 1600);
  return () => {
    stopped = true;
    clearInterval(timer);
    void ctx.close().catch(() => {});
  };
}

/**
 * Mounted once at the app root: rings for incoming calls from any screen,
 * recovers a call that started ringing just before a refresh, marks unanswered
 * calls missed, and renders the single global CallModal used for both sides.
 */
export function IncomingCallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallState | null>(null);
  const stopStatusRef = useRef<() => void>(() => {});

  // Presence should be alive anywhere in the app, not just on the messages page.
  useEffect(() => {
    if (!user?.id) return undefined;
    return ensurePresenceJoined();
  }, [user?.id]);

  // OS-level alerts for messages / engagement while the app is backgrounded.
  useDesktopNotifications(user?.id);
  useEffect(() => {
    if (user?.id && notificationsSupported()) void ensureNotificationsWorker();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;

    async function resolveCaller(callerId: string) {
      const res = await getUsers().catch(() => null);
      return (res?.profiles || []).find((u) => u.id === callerId) || null;
    }

    void (async () => {
      const pending = await getPendingIncomingCall().catch(() => null);
      if (cancelled || !pending) return;
      const caller = await resolveCaller(pending.caller_id);
      if (!cancelled && caller) {
        setIncomingCall({ user: caller, type: pending.kind, callId: pending.id });
      }
    })();

    const stop = subscribeIncomingCalls(async (call) => {
      const caller = await resolveCaller(call.caller_id);
      if (!cancelled && caller) setIncomingCall({ user: caller, type: call.kind, callId: call.id });
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [user?.id]);

  // Ring + auto-miss while a call is ringing for this device.
  useEffect(() => {
    if (!incomingCall) return undefined;
    const stopRing = startRingtone();

    // The user is on another tab/app: surface a system notification with
    // Answer / Decline buttons (sw.js relays clicks back as window messages).
    const toggles = getPreferences().toggles;
    if (
      (toggles["notify_calls"] ?? true) &&
      (toggles["notify_system"] ?? true) &&
      typeof document !== "undefined" &&
      (document.visibilityState === "hidden" || !document.hasFocus())
    ) {
      void showSystemNotification({
        id: incomingCall.callId,
        tag: `spaces-call-${incomingCall.callId}`,
        title: `${incomingCall.user.display_name} is calling`,
        body: `Incoming ${incomingCall.type === "video" ? "video" : "audio"} call — tap to open`,
        url: "/messages",
        requireInteraction: true,
        silent: !(toggles["notify_sounds"] ?? true),
        actions: [
          { action: "answer", title: "Answer" },
          { action: "decline", title: "Decline" },
        ],
      });
    }

    const onAction = (e: MessageEvent) => {
      const msg = e.data as { type?: string; action?: string; callId?: string } | null;
      if (msg?.type !== "call-notification-action" || msg.callId !== incomingCall.callId) return;
      if (msg.action === "answer") void acceptIncomingCall();
      else if (msg.action === "decline") void declineIncomingCall();
    };
    window.addEventListener("message", onAction);

    const timer = setTimeout(() => {
      void markCallMissed(incomingCall.callId).catch(() => {});
      setIncomingCall(null);
    }, RING_TIMEOUT_MS);
    return () => {
      stopRing();
      window.removeEventListener("message", onAction);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingCall]);

  function startCall(target: Profile, type: CallKind) {
    void (async () => {
      try {
        const row = await createCall(target.id, type);
        if (!row) return;
        setActiveCall({ user: target, type, callId: row.id, role: "caller", status: "ringing" });
        stopStatusRef.current();
        stopStatusRef.current = subscribeCallStatus(row.id, (call) => {
          if (call.status === "active") {
            setActiveCall((c) => (c && c.callId === row.id ? { ...c, status: "active" } : c));
          } else if (call.status === "declined" || call.status === "ended" || call.status === "missed") {
            toast.info(
              call.status === "declined" ? "Call declined" : call.status === "missed" ? "No answer" : "Call ended",
            );
            setActiveCall((c) => (c && c.callId === row.id ? null : c));
          }
        });
        setTimeout(() => {
          setActiveCall((c) => {
            if (c?.callId === row.id && c.status === "ringing") {
              void markCallMissed(row.id);
              toast.info("No answer");
              return null;
            }
            return c;
          });
        }, RING_TIMEOUT_MS);
      } catch {
        toast.error("Couldn't start the call.");
      }
    })();
  }

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    const { callId, user: caller, type } = incomingCall;
    await answerCall(callId);
    setActiveCall({ user: caller, type, callId, role: "callee", status: "active" });
    setIncomingCall(null);
  }

  async function declineIncomingCall() {
    if (!incomingCall) return;
    await declineCall(incomingCall.callId).catch(() => {});
    setIncomingCall(null);
  }

  const value = useMemo(() => ({ startCall }), []);

  return (
    <CallDialerContext.Provider value={value}>
      {children}

      {activeCall && (
        <CallModal
          partner={activeCall.user}
          type={activeCall.type}
          isOpen
          callId={activeCall.callId}
          role={activeCall.role}
          callStatus={activeCall.status}
          onClose={() => {
            if (activeCall.callId) void endCall(activeCall.callId, 0);
            setActiveCall(null);
          }}
        />
      )}

      {incomingCall && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
          role="dialog"
          aria-modal="true"
          aria-label={`Incoming ${incomingCall.type} call from ${incomingCall.user.display_name}`}
        >
          <div className="glass-panel w-full max-w-sm rounded-3xl border border-border/80 bg-card/95 p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 w-fit">
              <Avatar
                src={incomingCall.user.avatar_url}
                name={incomingCall.user.display_name}
                className="h-20 w-20"
              />
            </div>
            <p className="text-sm font-semibold text-foreground">{incomingCall.user.display_name}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Incoming {incomingCall.type === "video" ? "video" : "audio"} call…
            </p>
            <div className="mt-6 flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => void declineIncomingCall()}
                aria-label="Decline call"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white transition-transform hover:scale-105"
              >
                <X className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={() => void acceptIncomingCall()}
                aria-label="Accept call"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white transition-transform hover:scale-105"
              >
                {incomingCall.type === "video" ? <Video className="h-6 w-6" /> : <Phone className="h-6 w-6" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </CallDialerContext.Provider>
  );
}
