import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { CallKind } from "@/lib/calls";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

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
 */
export function useCallSession({ callId, role, kind, enabled }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [mediaError, setMediaError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
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
    setConnection("connecting");

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
      else if (state === "failed") setConnection("failed");
      else if (state === "disconnected" || state === "closed") setConnection("closed");
    };

    const channel = supabase.channel(`call-signal-${callId}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    const send = (event: string, payload: unknown) =>
      channel.send({ type: "broadcast", event, payload });

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

    channel
      .on("broadcast", { event: "offer" }, async ({ payload }) => {
        if (role !== "callee" || !payload?.sdp) return;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        void send("answer", { sdp: answer });
      })
      .on("broadcast", { event: "answer" }, async ({ payload }) => {
        if (role !== "caller" || !payload?.sdp) return;
        if (pc.signalingState === "stable") return;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await flushCandidates();
      })
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
          void send("offer", { sdp: offer });
        } else {
          void send("ready", {});
        }
      });

    return () => {
      cancelled = true;
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

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }, []);

  return {
    localStream,
    remoteStream,
    connection,
    mediaError,
    setMicEnabled,
    setCameraEnabled,
    replaceVideoTrack,
    hangUp: cleanup,
  };
}
