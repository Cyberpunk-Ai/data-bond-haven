import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { buildIceServers } from "@/lib/webrtc/ice";
import type { CallKind } from "@/lib/calls";

export type ConnectionState = "idle" | "connecting" | "connected" | "failed" | "closed";

interface Options {
  callId: string | null;
  /** The caller creates the offer; the callee answers it. */
  role: "caller" | "callee";
  kind: CallKind;
  /** Only start negotiating once the callee has picked up. */
  enabled: boolean;
}

/**
 * Real peer-to-peer audio/video. Signalling (offer, answer, ICE candidates)
 * travels over a Supabase realtime broadcast channel shared by both people.
 * TURN relay is fetched as short-lived ephemeral credentials from the server
 * (see lib/webrtc/ice.ts) — no relay secret is ever baked into the bundle.
 * Public STUN is the fallback when no TURN is configured.
 */
export function useCallSession({ callId, role, kind, enabled }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [mediaError, setMediaError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const dbChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const cleanedUp = useRef(false);
  // Live signalling hooks (wired when a session starts) so track swaps made
  // outside the connect effect can offer/answer too (voice -> video upgrade).
  const sendRef = useRef<(event: string, payload: unknown) => void>(() => {});
  const persistRef = useRef<(kind: "offer" | "answer", sdp: unknown) => void>(() => {});

  const cleanup = useCallback(() => {
    if (cleanedUp.current) return;
    cleanedUp.current = true;
    pcRef.current?.getSenders().forEach((s) => {
      try {
        s.track?.stop();
      } catch {
        /* ignore */
      }
    });
    pcRef.current?.close();
    pcRef.current = null;
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    if (dbChannelRef.current) {
      supabase.removeChannel(dbChannelRef.current);
      dbChannelRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setConnection("closed");
  }, []);

  useEffect(() => {
    if (!callId || !enabled) return undefined;

    let cancelled = false;
    cleanedUp.current = false;
    setConnection("connecting");

    void (async () => {
      // Ephemeral TURN credentials are fetched before the connection is created
      // (plan §S4); a session cancelled during the await never builds a peer.
      const iceServers = await buildIceServers();
      if (cancelled) return;

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      const remote = new MediaStream();
      setRemoteStream(remote);

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remote.addTrack(track));
        setRemoteStream(new MediaStream(remote.getTracks()));
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") setConnection("connected");
        else if (state === "failed") {
          // Try a single ICE restart before giving up — flaky wifi/NAT rebinds
          // frequently recover this way without dropping the call.
          if (role === "caller") {
            void pc
              .createOffer({ iceRestart: true })
              .then((offer) => pc.setLocalDescription(offer))
              .then(() => {
                void persist("offer", pc.localDescription);
                void send("offer", { sdp: pc.localDescription });
              })
              .catch(() => setConnection("failed"));
          } else {
            setConnection("failed");
          }
        } else if (state === "disconnected" || state === "closed") setConnection("closed");
      };

      const channel = supabase.channel(`call-signal-${callId}`, {
        // private:true → realtime.messages RLS (20260925000009) restricts the
        // 1:1 call signalling channel to the two participants + staff.
        config: { broadcast: { self: false }, private: true },
      });
      channelRef.current = channel;

      const send = (event: string, payload: unknown) =>
        channel.send({ type: "broadcast", event, payload });

      // Durable write of an SDP blob into `call_signals` (plan §9). Broadcast is
      // kept for latency, but a peer that subscribes late would otherwise miss the
      // offer; the table is the guarantee. `from_profile` is stamped by a DB
      // trigger, so the client never supplies an identity.
      const persist = (kind: "offer" | "answer", sdp: unknown) => {
        // call_signals is newer than the generated Database types (typegen is an
        // M4 task); RLS + the sender trigger enforce participant-only writes.
        void (supabase as any)
          .from("call_signals")
          .insert({ call_id: callId, kind, payload: { sdp } });
      };
      sendRef.current = (event, payload) => void send(event, payload);
      persistRef.current = persist;

      pc.onicecandidate = (event) => {
        if (event.candidate) void send("ice", { from: role, candidate: event.candidate.toJSON() });
      };

      async function flushCandidates() {
        for (const candidate of pendingCandidates.current) {
          try {
            await pc.addIceCandidate(candidate);
          } catch {
            /* ignore malformed candidate */
          }
        }
        pendingCandidates.current = [];
      }

      // The same SDP can arrive twice (live broadcast + durable replay); dedupe on
      // the raw description so we never renegotiate against an already-applied one.
      let lastOfferApplied = "";
      let lastAnswerApplied = "";

      async function handleOffer(sdp: RTCSessionDescriptionInit | undefined) {
        // Either side can renegotiate now (e.g. adding video mid-call), so the
        // answerer is decided by signalling state, not role. Glare guard: skip
        // while we hold an unanswered offer of our own.
        if (!sdp?.sdp || sdp.sdp === lastOfferApplied) return;
        if (pc.signalingState === "have-local-offer") return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          lastOfferApplied = sdp.sdp;
          await flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          void send("answer", { sdp: answer });
          void persist("answer", answer);
        } catch {
          /* renegotiation races are retried via ICE restart */
        }
      }

      async function handleAnswer(sdp: RTCSessionDescriptionInit | undefined) {
        if (!sdp?.sdp || sdp.sdp === lastAnswerApplied) return;
        if (pc.signalingState !== "have-local-offer") return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          lastAnswerApplied = sdp.sdp;
          await flushCandidates();
        } catch {
          /* ignore */
        }
      }

      channel
        .on("broadcast", { event: "offer" }, async ({ payload }) => void handleOffer(payload?.sdp))
        .on(
          "broadcast",
          { event: "answer" },
          async ({ payload }) => void handleAnswer(payload?.sdp),
        )
        .on("broadcast", { event: "ice" }, async ({ payload }) => {
          if (!payload?.candidate || payload.from === role) return;
          if (!pc.remoteDescription) {
            pendingCandidates.current.push(payload.candidate);
            return;
          }
          try {
            await pc.addIceCandidate(payload.candidate);
          } catch {
            /* ignore */
          }
        })
        .subscribe(async (status) => {
          if (status !== "SUBSCRIBED" || cancelled) return;

          // Durable signalling channel: follow new inserts *before* replaying
          // history, and dedupe by SDP content so the overlap between the two is
          // harmless.
          const dbChannel = supabase
            .channel(`call-signals-db-${callId}`)
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "call_signals",
                filter: `call_id=eq.${callId}`,
              },
              (change) => {
                const row = change.new as {
                  kind?: string;
                  payload?: { sdp?: RTCSessionDescriptionInit };
                };
                if (row.kind === "offer") void handleOffer(row.payload?.sdp);
                else if (row.kind === "answer") void handleAnswer(row.payload?.sdp);
              },
            )
            .subscribe();
          dbChannelRef.current = dbChannel;

          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: kind === "video",
            });
            if (cancelled) {
              stream.getTracks().forEach((t) => t.stop());
              return;
            }
            localStreamRef.current = stream;
            setLocalStream(stream);
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          } catch {
            setMediaError(
              kind === "video"
                ? "We couldn't reach your camera or microphone. Check your browser permissions."
                : "We couldn't reach your microphone. Check your browser permissions.",
            );
          }

          if (role === "caller") {
            const offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: kind === "video",
            });
            await pc.setLocalDescription(offer);
            void persist("offer", offer);
            void send("offer", { sdp: offer });
          } else {
            // Callee: pull any offer that was written before it joined. This is
            // the exact race that used to make calls never connect (plan §9).
            const { data: prior } = await (supabase as any)
              .from("call_signals")
              .select("kind, payload")
              .eq("call_id", callId)
              .order("id");
            for (const row of (prior ?? []) as Array<{
              kind: string;
              payload?: { sdp?: RTCSessionDescriptionInit };
            }>) {
              if (row.kind === "offer") await handleOffer(row.payload?.sdp);
            }
            void send("ready", {});
          }
        });
    })();

    // Clean teardown if the tab/browser closes mid-call.
    const handleUnload = () => cleanup();
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, enabled, kind, role]);

  const setMicEnabled = useCallback((on: boolean) => {
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on));
  }, []);

  const setCameraEnabled = useCallback((on: boolean) => {
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = on));
  }, []);

  /**
   * Swaps the outgoing video track (camera <-> screen-share <-> off) using
   * `replaceTrack` on the existing sender so the call never renegotiates —
   * no flicker, no dropped audio, no re-ICE.
   */
  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const pc = pcRef.current;
    if (!pc) return;
    let sender = pc
      .getSenders()
      .find((s) => s.track?.kind === "video" || (!s.track && s.dtmf === null));
    if (!sender) sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
    } else if (track && localStreamRef.current) {
      // A brand-new video m-section (voice call upgrading to video or screen
      // share): attach it and renegotiate once so the peer starts receiving.
      pc.addTrack(track, localStreamRef.current);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      persistRef.current("offer", offer);
      sendRef.current("offer", { sdp: offer });
    }
    if (
      track &&
      localStreamRef.current &&
      !localStreamRef.current.getVideoTracks().includes(track)
    ) {
      // Keep the local preview stream in sync with whatever is actually being sent.
      localStreamRef.current
        .getVideoTracks()
        .forEach((t) => localStreamRef.current?.removeTrack(t));
      localStreamRef.current.addTrack(track);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
    }
  }, []);

  const replaceAudioTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "audio");
    if (sender && track) await sender.replaceTrack(track);
  }, []);

  /** Grabs the camera on demand so a voice call can become a video call
   * without a new peer connection. Pipe the track into replaceVideoTrack —
   * it renegotiates once if the call has no video section yet. */
  const startCamera = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    return stream.getVideoTracks()[0] ?? null;
  }, []);

  return {
    localStream,
    remoteStream,
    connection,
    mediaError,
    setMicEnabled,
    setCameraEnabled,
    replaceVideoTrack,
    replaceAudioTrack,
    startCamera,
    hangUp: cleanup,
  };
}
