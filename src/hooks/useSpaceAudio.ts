import { useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { appConfig } from "@/lib/config";

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

function iceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const { turnUrl, turnUsername, turnCredential } = appConfig.realtime;
  if (turnUrl) list.push({ urls: turnUrl.split(","), username: turnUsername, credential: turnCredential });
  return list;
}

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

  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const localStream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Apply mute to the outgoing track without renegotiating.
  useEffect(() => {
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (sfuAdapter) sfuAdapter.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    if (!enabled || !spaceId || !userId || userId === "guest") return;
    let cancelled = false;
    setStatus("connecting");
    const channel = supabase.channel(`space-audio:${spaceId}`, {
      config: { presence: { key: userId }, broadcast: { self: false } },
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
      pc = new RTCPeerConnection({ iceServers: iceServers() });
      pcs.current.set(peerId, pc);
      localStream.current?.getTracks().forEach((t) => pc!.addTrack(t, localStream.current!));
      if (!localStream.current) pc.addTransceiver("audio", { direction: "recvonly" });
      pc.onicecandidate = (e) => {
        if (e.candidate) void send({ kind: "ice", from: userId, to: peerId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
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
      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === "connected") setStatus("live");
        if (pc!.connectionState === "failed") closePeer(peerId);
      };
      return pc;
    }

    function closePeer(peerId: string) {
      pcs.current.get(peerId)?.close();
      pcs.current.delete(peerId);
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
      Object.entries(state).forEach(([id, metas]) => roster.set(id, { speaker: !!metas[0]?.speaker }));
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
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

  return { status, peers, speakingIds, overCapacity };
}
