import { useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { appConfig } from "@/lib/config";
import { buildIceServers } from "@/lib/webrtc/ice";

/**
 * Live audio for Spaces.
 *
 * Small rooms: WebRTC mesh. Each speaker sends their microphone directly to every
 * other participant; signalling (offers, answers, ICE) travels over a realtime
 * broadcast channel and presence tells everyone who is in the room.
 *
 * Large rooms: when VITE_SPACES_SFU_PROVIDER / VITE_SPACES_SFU_URL are set, a hosted
 * SFU adapter can be registered via `registerSfuAdapter` without touching the UI.
 */

export interface SfuAdapter {
  join(opts: { spaceId: string; userId: string; speaker: boolean }): Promise<void>;
  setMuted(muted: boolean): void;
  leave(): void;
}
let sfuAdapter: SfuAdapter | null = null;
export function registerSfuAdapter(adapter: SfuAdapter) {
  sfuAdapter = adapter;
}

// Public STUN default until the (cached) ephemeral TURN fetch resolves.
const STUN_ONLY: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

type Signal =
  | { kind: "offer" | "answer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; from: string; to: string; candidate: RTCIceCandidateInit };

export type SpaceAudioStatus = "idle" | "connecting" | "live" | "mic-blocked" | "error";

export function useSpaceAudio(opts: {
  spaceId: string;
  userId: string;
  speaker: boolean;
  muted: boolean;
  enabled: boolean;
}) {
  const { spaceId, userId, speaker, muted, enabled } = opts;
  const [status, setStatus] = useState<SpaceAudioStatus>("idle");
  const [peers, setPeers] = useState<string[]>([]);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [overCapacity, setOverCapacity] = useState(false);
  const [recordingBytes, setRecordingBytes] = useState(0);
  const [isRecordingLocally, setIsRecordingLocally] = useState(false);

  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const remoteStreams = useRef(new Map<string, MediaStream>());
  const localStream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Short-lived TURN is fetched per session (see the connect effect); STUN is
  // the immediate default so a peer built before the fetch resolves still works.
  const iceServersRef = useRef<RTCIceServer[]>(STUN_ONLY);

  // --- Room recording: mixes local + remote audio into one file. Host-only,
  // enforced by the caller; this just does the capture/upload-ready blob work.
  const recorder = useRef<MediaRecorder | null>(null);
  const recordCtx = useRef<AudioContext | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordBytesRef = useRef(0);
  const recordMaxBytesRef = useRef(0);
  const recordResolve = useRef<((blob: Blob) => void) | null>(null);
  const onRecordOverLimit = useRef<(() => void) | null>(null);

  function startRecording(maxBytes: number, overLimit?: () => void): boolean {
    if (recorder.current) return false;
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      if (localStream.current) ctx.createMediaStreamSource(localStream.current).connect(dest);
      for (const stream of remoteStreams.current.values()) {
        try {
          ctx.createMediaStreamSource(stream).connect(dest);
        } catch {
          /* stream may not be ready yet */
        }
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const mr = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 64000 });
      recordChunks.current = [];
      recordBytesRef.current = 0;
      recordMaxBytesRef.current = maxBytes;
      onRecordOverLimit.current = overLimit ?? null;
      mr.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        recordChunks.current.push(e.data);
        recordBytesRef.current += e.data.size;
        setRecordingBytes(recordBytesRef.current);
        if (recordMaxBytesRef.current > 0 && recordBytesRef.current >= recordMaxBytesRef.current) {
          onRecordOverLimit.current?.();
          stopRecording();
        }
      };
      mr.start(1000);
      recorder.current = mr;
      recordCtx.current = ctx;
      setIsRecordingLocally(true);
      return true;
    } catch {
      return false;
    }
  }

  function stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      const mr = recorder.current;
      if (!mr) {
        resolve(new Blob([], { type: "audio/webm" }));
        return;
      }
      recordResolve.current = resolve;
      mr.onstop = () => {
        const blob = new Blob(recordChunks.current, { type: mr.mimeType || "audio/webm" });
        recordChunks.current = [];
        void recordCtx.current?.close();
        recordCtx.current = null;
        recorder.current = null;
        setIsRecordingLocally(false);
        recordResolve.current?.(blob);
        recordResolve.current = null;
      };
      try {
        mr.stop();
      } catch {
        setIsRecordingLocally(false);
      }
    });
  }

  // Apply mute to the outgoing track without renegotiating.
  useEffect(() => {
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (sfuAdapter) sfuAdapter.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    if (!enabled || !spaceId || !userId || userId === "guest") return;
    let cancelled = false;
    setStatus("connecting");
    // Fetch short-lived TURN once per session (globally cached in ice.ts); a
    // ready connection before it resolves falls back to STUN-only.
    void buildIceServers()
      .then((servers) => {
        if (!cancelled) iceServersRef.current = servers;
      })
      .catch(() => undefined);
    const channel = supabase.channel(`space-audio:${spaceId}`, {
      // private:true makes Supabase enforce the realtime.messages RLS policies
      // (20260925000009) so only the host/participants/staff can join the
      // signalling channel — otherwise SDP offers are world-readable.
      config: { presence: { key: userId }, broadcast: { self: false }, private: true },
    });
    const roster = new Map<string, { speaker: boolean }>();
    const analysers: Array<() => void> = [];

    const send = (payload: Signal) => channel.send({ type: "broadcast", event: "signal", payload });

    function watchLevel(id: string, stream: MediaStream) {
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const iv = setInterval(() => {
          an.getByteFrequencyData(buf);
          const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
          const on = avg > 18 && !(id === userId && mutedRef.current);
          setSpeakingIds((prev) => {
            if (prev.has(id) === on) return prev;
            const next = new Set(prev);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          });
        }, 200);
        analysers.push(() => {
          clearInterval(iv);
          void ctx.close();
        });
      } catch {
        /* analyser optional */
      }
    }

    function getPc(peerId: string) {
      let pc = pcs.current.get(peerId);
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
      pcs.current.set(peerId, pc);
      localStream.current?.getTracks().forEach((t) => pc!.addTrack(t, localStream.current!));
      if (!localStream.current) pc.addTransceiver("audio", { direction: "recvonly" });
      pc.onicecandidate = (e) => {
        if (e.candidate)
          void send({ kind: "ice", from: userId, to: peerId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        remoteStreams.current.set(peerId, stream);
        let el = audios.current.get(peerId);
        if (!el) {
          el = new Audio();
          el.autoplay = true;
          audios.current.set(peerId, el);
        }
        el.srcObject = stream;
        void el.play().catch(() => undefined);
        watchLevel(peerId, stream);
      };
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === "connected") setStatus("live");
        if (pc!.connectionState === "disconnected") {
          // Give the network a moment to recover before tearing the peer down.
          reconnectTimer = setTimeout(async () => {
            if (pc!.connectionState !== "connected" && !cancelled) {
              try {
                const offer = await pc!.createOffer({ iceRestart: true });
                await pc!.setLocalDescription(offer);
                await send({ kind: "offer", from: userId, to: peerId, sdp: offer });
              } catch {
                closePeer(peerId);
              }
            }
          }, 2500);
        }
        if (pc!.connectionState === "failed") closePeer(peerId);
      };
      (pc as any)._clearReconnect = () => reconnectTimer && clearTimeout(reconnectTimer);
      return pc;
    }

    function closePeer(peerId: string) {
      const pc = pcs.current.get(peerId);
      (pc as any)?._clearReconnect?.();
      pc?.close();
      pcs.current.delete(peerId);
      remoteStreams.current.delete(peerId);
      const el = audios.current.get(peerId);
      if (el) {
        el.srcObject = null;
        audios.current.delete(peerId);
      }
    }

    async function connectTo(peerId: string) {
      const pc = getPc(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await send({ kind: "offer", from: userId, to: peerId, sdp: offer });
    }

    function sync() {
      const state = channel.presenceState<{ speaker: boolean }>();
      roster.clear();
      Object.entries(state).forEach(([id, metas]) =>
        roster.set(id, { speaker: !!metas[0]?.speaker }),
      );
      const others = [...roster.keys()].filter((id) => id !== userId);
      setPeers(others);
      const speakers = [...roster.values()].filter((r) => r.speaker).length;
      setOverCapacity(speakers > appConfig.realtime.maxMeshSpeakers);
      // Connect when either side is a speaker; the lower id initiates to avoid glare.
      for (const id of others) {
        const needs = speaker || roster.get(id)?.speaker;
        if (needs && !pcs.current.has(id) && userId < id) void connectTo(id);
        if (!needs && pcs.current.has(id)) closePeer(id);
      }
      for (const id of [...pcs.current.keys()]) if (!roster.has(id)) closePeer(id);
      if (!others.length) setStatus("live");
    }

    channel
      .on("presence", { event: "sync" }, sync)
      .on("broadcast", { event: "signal" }, async ({ payload }) => {
        const msg = payload as Signal;
        if (msg.to !== userId) return;
        const pc = getPc(msg.from);
        try {
          if (msg.kind === "offer") {
            await pc.setRemoteDescription(msg.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await send({ kind: "answer", from: userId, to: msg.from, sdp: answer });
          } else if (msg.kind === "answer") {
            await pc.setRemoteDescription(msg.sdp);
          } else if (msg.kind === "ice") {
            await pc.addIceCandidate(msg.candidate);
          }
        } catch (err) {
          console.warn("[spaces-audio] signalling error", err);
        }
      });

    (async () => {
      if (speaker) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              sampleRate: 48000,
            },
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          stream.getAudioTracks().forEach((t) => (t.enabled = !mutedRef.current));
          localStream.current = stream;
          watchLevel(userId, stream);
        } catch {
          setStatus("mic-blocked");
        }
      }
      if (sfuAdapter && appConfig.realtime.sfuProvider) {
        await sfuAdapter.join({ spaceId, userId, speaker }).catch(() => setStatus("error"));
        return;
      }
      channel.subscribe(async (s) => {
        if (s === "SUBSCRIBED") await channel.track({ speaker });
      });
    })();

    return () => {
      cancelled = true;
      analysers.forEach((stop) => stop());
      [...pcs.current.keys()].forEach(closePeer);
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
      sfuAdapter?.leave();
      void supabase.removeChannel(channel);
      setStatus("idle");
      setSpeakingIds(new Set());
    };
  }, [enabled, spaceId, userId, speaker]);

  return {
    status,
    peers,
    speakingIds,
    overCapacity,
    startRecording,
    stopRecording,
    isRecordingLocally,
    recordingBytes,
  };
}
