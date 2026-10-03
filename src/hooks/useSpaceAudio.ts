import { useCallback, useEffect, useRef, useState } from "react";

import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { appConfig } from "@/lib/config";
import {
  canBroadcast,
  initiatesPair,
  isOverCapacity,
  meshAudience,
  meshSaturated,
  pairAllowedByAudience,
} from "@/lib/spaces-stage";
import { buildIceServers } from "@/lib/webrtc/ice";

/**
 * Live audio for Spaces.
 *
 * The stage is what the room hears: the host plus the speakers the host invites
 * (rules in `lib/spaces-stage.ts`). Everybody else is a listener — they receive
 * audio and their microphone is never even switched on, so joining, tapping
 * around or leaving cannot interrupt the broadcast for anyone.
 *
 * Small rooms: WebRTC mesh. Each stage participant sends their microphone to
 * every other participant; signalling (offers, answers, ICE) travels over a
 * private realtime broadcast channel, and presence tells everyone who is in the
 * room and who is on the stage.
 *
 * Two things this file is deliberate about, because both caused dropouts:
 *  1. The channel and the peer connections live for the whole session. Gaining
 *     or losing the floor swaps the outgoing track with `replaceTrack()`, which
 *     needs no renegotiation — so nobody else's audio blinks when a role
 *     changes, and a listener joining costs the room nothing.
 *  2. One shared AudioContext does the metering, the silent publishing track and
 *     the recording mix, instead of one per stream. Browsers allow only a handful
 *     of contexts per tab, and every extra one is CPU the audio thread lost.
 *
 * Large rooms: when VITE_SPACES_SFU_PROVIDER / VITE_SPACES_SFU_URL are set, a
 * hosted SFU adapter can be registered via `registerSfuAdapter` without
 * touching the UI.
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

/** Speech meters are polled, not streamed: 5 a second is enough for a ring. */
const LEVEL_POLL_MS = 200;

type Signal =
  | { kind: "offer" | "answer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; from: string; to: string; candidate: RTCIceCandidateInit }
  // "don't bother calling me": sent when the audience budget says this pair
  // should not exist, so the offering side stops waiting for an answer.
  | { kind: "reject"; from: string; to: string };

export type SpaceAudioStatus = "idle" | "connecting" | "live" | "mic-blocked" | "error";

export function useSpaceAudio(opts: {
  spaceId: string;
  userId: string;
  /** True only for the host and the speakers the host invited. */
  speaker: boolean;
  muted: boolean;
  enabled: boolean;
}) {
  const { spaceId, userId, speaker, muted, enabled } = opts;
  const [status, setStatus] = useState<SpaceAudioStatus>("idle");
  const [peers, setPeers] = useState<string[]>([]);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [overCapacity, setOverCapacity] = useState(false);
  // Fan-out, reported honestly. `overFanOut` is the room's own verdict (more
  // listeners than this mesh can feed, the same number on every device); the
  // stage trips it while still sounding fine, because a speaker only has to
  // carry the first `maxMeshListeners` of them. `unheard` is personal: this
  // device is a listener on the wrong side of that budget, so it is in the room
  // and cannot be given audio — which must be said out loud rather than left as
  // a dead speaker icon.
  const [overFanOut, setOverFanOut] = useState(false);
  const [unheard, setUnheard] = useState(false);
  const [recordingBytes, setRecordingBytes] = useState(0);
  const [isRecordingLocally, setIsRecordingLocally] = useState(false);
  // Browsers refuse to start remote audio until the page has seen a gesture.
  // Without a nudge the room simply "has no sound", so the state is surfaced.
  const [needsGesture, setNeedsGesture] = useState(false);

  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const senders = useRef(new Map<string, RTCRtpSender>());
  // ICE-restart timers, keyed by peer so a link that recovers (or closes) cannot
  // leave a callback behind to renegotiate a connection that is already gone.
  const reconnects = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const remoteStreams = useRef(new Map<string, MediaStream>());
  const localStream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // The stage status has to be readable from effects that must not restart when
  // it changes, so it lives in a ref as well as in the props.
  const stageRef = useRef(speaker);
  stageRef.current = canBroadcast(speaker ? "speaker" : "listener");
  const channelRef = useRef<RealtimeChannel | null>(null);
  const roster = useRef(new Map<string, { speaker: boolean }>());
  // The audience verdict from the last presence sync. Null until presence has
  // arrived: a rule that has never been evaluated must not refuse a call.
  const servedRef = useRef<Set<string> | null>(null);
  const syncRef = useRef<(() => void) | null>(null);
  const negotiateRef = useRef<((peerId: string) => void) | null>(null);
  // The track every connection publishes from the first offer onwards: silence
  // for a listener, the microphone once the host has given them the floor.
  const silentTrack = useRef<MediaStreamTrack | null>(null);
  const outgoing = useRef<MediaStreamTrack | null>(null);
  const levels = useRef(new Map<string, () => void>());
  // Short-lived TURN is fetched per session (globally cached in ice.ts); a peer
  // built before it resolves still works, on STUN only.
  const iceServersRef = useRef<RTCIceServer[]>(STUN_ONLY);

  // --- Room recording: mixes local + stage audio into one file. Host-only,
  // enforced by the caller; this does the capture/upload-ready blob work.
  const recorder = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordBytesRef = useRef(0);
  const recordMaxBytesRef = useRef(0);
  const recordResolve = useRef<((blob: Blob) => void) | null>(null);
  const onRecordOverLimit = useRef<(() => void) | null>(null);
  // One persistent context for the whole session: the recording mix, the silent
  // track and every level meter share it. Keeping it alive across stop/start
  // means a peer who joins after recording began is still captured, and a
  // re-record does not rebuild every source node.
  const audioCtx = useRef<AudioContext | null>(null);
  const mixDest = useRef<MediaStreamAudioDestinationNode | null>(null);
  const silentNodes = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null);
  const mixed = useRef<Set<MediaStream>>(new Set());

  function ctx(): AudioContext | null {
    try {
      if (!audioCtx.current || audioCtx.current.state === "closed") {
        try {
          // 48 kHz matches Opus, so the voice is encoded without resampling.
          audioCtx.current = new AudioContext({ sampleRate: 48000 });
        } catch {
          audioCtx.current = new AudioContext();
        }
        mixDest.current = null;
        mixed.current = new Set();
      }
      if (audioCtx.current.state === "suspended") {
        void audioCtx.current.resume().catch(() => undefined);
      }
      return audioCtx.current;
    } catch {
      return null;
    }
  }

  /**
   * A listener never touches the microphone, but each connection still needs an
   * outgoing audio track: publishing from the very first offer is what lets a
   * role change swap the track in place (`replaceTrack`) instead of
   * renegotiating — and renegotiation is what makes the whole room blink.
   */
  function ensureSilentTrack(): MediaStreamTrack | null {
    if (silentTrack.current) return silentTrack.current;
    const ac = ctx();
    if (!ac) return null;
    try {
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0; // Digital silence, but a live source so frames flow.
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      silentNodes.current = { osc, gain };
      silentTrack.current = dest.stream.getAudioTracks()[0] ?? null;
      return silentTrack.current;
    } catch {
      return null;
    }
  }

  /** Destination the recorder reads from, created on the shared context. */
  function ensureMixDest(): MediaStreamAudioDestinationNode | null {
    const ac = ctx();
    if (!ac) return null;
    if (!mixDest.current || mixDest.current.context !== ac) {
      mixDest.current = ac.createMediaStreamDestination();
    }
    return mixDest.current;
  }

  /** Route one MediaStream into the recording mix exactly once. */
  function tapStream(stream: MediaStream) {
    const ac = audioCtx.current;
    const dest = ensureMixDest();
    if (!ac || !dest || mixed.current.has(stream)) return;
    try {
      ac.createMediaStreamSource(stream).connect(dest);
      mixed.current.add(stream);
    } catch {
      /* stream may not be ready yet; a later connect will retry */
    }
  }

  /**
   * Loudness meter for one stream, on the shared context. Only stage members
   * are metered: a listener's track is silence by policy, and metering a hundred
   * of them would take the CPU this audio needs. One meter per id, replaced on
   * re-connect and dropped on disconnect — leaked intervals are how a long room
   * starts to stutter.
   */
  function watchLevel(id: string, stream: MediaStream) {
    stopLevel(id);
    const ac = ctx();
    if (!ac) return;
    try {
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
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
      }, LEVEL_POLL_MS);
      levels.current.set(id, () => {
        clearInterval(iv);
        try {
          src.disconnect();
          an.disconnect();
        } catch {
          /* already torn down */
        }
      });
    } catch {
      /* the meter is optional; audio keeps flowing without it */
    }
  }

  function stopLevel(id: string) {
    levels.current.get(id)?.();
    levels.current.delete(id);
  }

  function startRecording(maxBytes: number, overLimit?: () => void): boolean {
    if (recorder.current) return false;
    try {
      const dest = ensureMixDest();
      if (!dest) return false;
      // Tap everyone already on the stage; peers who arrive later are tapped
      // from `ontrack`, so the mix always holds the full room.
      for (const [peerId, stream] of remoteStreams.current) {
        if (roster.current.get(peerId)?.speaker) tapStream(stream);
      }
      if (localStream.current) tapStream(localStream.current);
      void audioCtx.current?.resume().catch(() => undefined);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const mr = new MediaRecorder(dest.stream, {
        mimeType,
        audioBitsPerSecond: appConfig.realtime.audioMaxKbps * 1000,
      });
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
        // The mixer stays alive so a re-record (and anyone who joined while we
        // were stopped) is captured without rebuilding every source node.
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

  /** Start/resume playback of everything on offer, after a user gesture. */
  const unlock = useCallback(() => {
    setNeedsGesture(false);
    void audioCtx.current?.resume().catch(() => undefined);
    for (const el of audios.current.values()) el.play().catch(() => undefined);
  }, []);

  /**
   * Opus for speech: 64 kbit/s mono carries a voice cleanly, DTX stops
   * transmitting during pauses (that headroom is what keeps many uplinks smooth)
   * and inband FEC repairs a lost packet instead of leaving a click.
   */
  function shapeOutgoing(sender: RTCRtpSender) {
    try {
      const params = sender.getParameters();
      const encodings = params.encodings?.length ? [...params.encodings] : [{}];
      // maxAverageBitrate/dtx are Opus knobs the DOM typings still lag behind.
      encodings[0] = {
        ...encodings[0],
        maxAverageBitrate: appConfig.realtime.audioMaxKbps * 1000,
        dtx: true,
      } as RTCRtpEncodingParameters;
      void sender
        .setParameters({ ...params, encodings } as RTCRtpSendParameters)
        .catch(() => undefined);
    } catch {
      /* rejected the tweak; the browser default is still usable */
    }
  }

  /**
   * Point every live connection at the track this participant should publish
   * (their microphone, or silence). `replaceTrack` changes no SDP, so the rest of
   * the room cannot tell that anyone's role just changed.
   */
  const publish = useCallback((track: MediaStreamTrack | null) => {
    const desired = track ?? silentTrack.current ?? ensureSilentTrack();
    if (!desired) return;
    outgoing.current = desired;
    const source = localStream.current ?? new MediaStream([desired]);
    for (const [peerId, sender] of [...senders.current]) {
      const pc = pcs.current.get(peerId);
      if (!pc || pc.connectionState === "closed") {
        senders.current.delete(peerId);
        continue;
      }
      if (sender.track === desired) continue;
      sender.replaceTrack(desired).catch(() => undefined);
      shapeOutgoing(sender);
    }
    // Connections built while no track could be created at all (an older
    // browser without a usable AudioContext): attach now and renegotiate that
    // single pair. Rare, and only ever disturbs the two ends of one link.
    for (const [peerId, pc] of [...pcs.current]) {
      if (senders.current.has(peerId)) continue;
      try {
        const sender = pc.addTrack(desired, source);
        senders.current.set(peerId, sender);
        shapeOutgoing(sender);
        negotiateRef.current?.(peerId);
      } catch {
        /* pc is mid-teardown; the next roster sync rebuilds it */
      }
    }
    // Empty deps on purpose: `ensureSilentTrack` and `shapeOutgoing` only touch
    // refs, so this identity stays stable for the life of the room, and a
    // changing `publish` would restart the microphone effect that depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mute without renegotiating: the track stays attached, just disabled. That
  // is why unmuting is instant instead of another connection round.
  useEffect(() => {
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (sfuAdapter) sfuAdapter.setMuted(muted);
  }, [muted]);

  // --- Microphone lifecycle, apart from the channel so that gaining or losing
  // the floor cannot disturb anybody else's connection.
  useEffect(() => {
    const onStage = enabled && stageRef.current && !!spaceId && !!userId && userId !== "guest";
    if (!onStage) {
      // A listener never requests the microphone — no prompt, no permission,
      // no uplink. Their connections keep receiving.
      const stream = localStream.current;
      localStream.current = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stopLevel(userId);
      setSpeakingIds((prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      publish(null);
      void channelRef.current?.track({ speaker: false }).catch?.(() => undefined);
      syncRef.current?.();
      return;
    }
    let cancelled = false;
    void (async () => {
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
        stream.getAudioTracks().forEach((t) => {
          t.enabled = !mutedRef.current;
          // Tell the browser this is a voice: it then tunes capture, AGC and the
          // encoder for speech rather than for music.
          t.contentHint = "speech";
        });
        localStream.current = stream;
        publish(stream.getAudioTracks()[0] ?? null);
        watchLevel(userId, stream);
        void channelRef.current?.track({ speaker: true }).catch?.(() => undefined);
        syncRef.current?.();
      } catch {
        setStatus("mic-blocked");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `watchLevel` is a plain helper over refs; `speaker` is read through
    // stageRef so this effect can restart on a role change without taking the
    // mesh with it — which is precisely what it must never do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, speaker, spaceId, userId, publish]);

  // --- Channel and mesh: built once per room, never rebuilt on a role change.
  useEffect(() => {
    if (!enabled || !spaceId || !userId || userId === "guest") return;
    let cancelled = false;
    // This room's own maps, held directly so the cleanup below tears down exactly
    // the connections this session opened.
    const roomPeers = pcs;
    const restartTimers = reconnects;
    setStatus("connecting");
    // Fetch short-lived TURN once per session (globally cached in ice.ts); a
    // connection ready before it resolves falls back to STUN only.
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
    channelRef.current = channel;

    const send = (payload: Signal) => channel.send({ type: "broadcast", event: "signal", payload });

    /** Play a stage member's audio, asking for a gesture if the browser won't. */
    function attachPlayback(peerId: string, stream: MediaStream) {
      let el = audios.current.get(peerId);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        audios.current.set(peerId, el);
      }
      el.srcObject = stream;
      el.play()
        .then(unlock)
        .catch(() => setNeedsGesture(true));
      // Peers who join after recording started are tapped here, so the mix (and
      // therefore the replay) always holds the whole stage.
      tapStream(stream);
      watchLevel(peerId, stream);
    }

    function detachPlayback(peerId: string) {
      stopLevel(peerId);
      const el = audios.current.get(peerId);
      if (el) {
        el.pause();
        el.srcObject = null;
        audios.current.delete(peerId);
      }
      setSpeakingIds((prev) => {
        if (!prev.has(peerId)) return prev;
        const next = new Set(prev);
        next.delete(peerId);
        return next;
      });
    }

    function getPc(peerId: string) {
      let pc = pcs.current.get(peerId);
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
      pcs.current.set(peerId, pc);
      const track = outgoing.current ?? ensureSilentTrack();
      if (track) {
        const source = localStream.current ?? new MediaStream([track]);
        const sender = pc.addTrack(track, source);
        senders.current.set(peerId, sender);
        shapeOutgoing(sender);
      } else {
        // No context available: receive for now, `publish` attaches later.
        pc.addTransceiver("audio", { direction: "recvonly" });
      }
      pc.onicecandidate = (e) => {
        if (e.candidate)
          void send({ kind: "ice", from: userId, to: peerId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        remoteStreams.current.set(peerId, stream);
        // Only the stage is worth playing: a listener's track is silence, and
        // wiring a player plus a meter for each of them is pure cost.
        if (roster.current.get(peerId)?.speaker) attachPlayback(peerId, stream);
      };
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === "connected") setStatus("live");
        if (pc!.connectionState === "disconnected" && !reconnects.current.has(peerId)) {
          // Give the network a moment to recover before tearing the peer down.
          reconnectTimer = setTimeout(() => {
            reconnects.current.delete(peerId);
            if (pc!.connectionState !== "connected" && !cancelled) {
              void pc!
                .createOffer({ iceRestart: true })
                .then((offer) =>
                  pc!
                    .setLocalDescription(offer)
                    .then(() => send({ kind: "offer", from: userId, to: peerId, sdp: offer }))
                    .catch(() => closePeer(peerId)),
                )
                .catch(() => closePeer(peerId));
            }
          }, 2500);
          reconnects.current.set(peerId, reconnectTimer);
        }
        if (pc!.connectionState === "failed") closePeer(peerId);
      };
      return pc;
    }

    function closePeer(peerId: string) {
      const pending = reconnects.current.get(peerId);
      if (pending) {
        clearTimeout(pending);
        reconnects.current.delete(peerId);
      }
      const pc = pcs.current.get(peerId);
      pc?.close();
      pcs.current.delete(peerId);
      senders.current.delete(peerId);
      remoteStreams.current.delete(peerId);
      detachPlayback(peerId);
    }

    async function connectTo(peerId: string) {
      const pc = getPc(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await send({ kind: "offer", from: userId, to: peerId, sdp: offer });
    }
    negotiateRef.current = connectTo;

    function sync() {
      const state = channel.presenceState<{ speaker?: boolean }>();
      roster.current.clear();
      Object.entries(state).forEach(([id, metas]) => {
        roster.current.set(id, { speaker: !!(metas[0] as { speaker?: boolean })?.speaker });
      });
      const others = [...roster.current.keys()].filter((id) => id !== userId);
      setPeers(others);
      const stage = [...roster.current.values()].filter((r) => r.speaker).length;
      setOverCapacity(isOverCapacity(stage, appConfig.realtime.maxMeshSpeakers));
      // Fan-out. Who the stage can afford to feed is worked out from presence
      // alone, and the input is the *whole* roster — including this device — so
      // that every browser in the room slices the same list and agrees on the
      // answer. Excluding yourself would give each tab a different queue, which
      // is how one side offers and the other refuses.
      const cap = appConfig.realtime.maxMeshListeners;
      const listeners = [...roster.current.keys()].filter((id) => !roster.current.get(id)?.speaker);
      const served = meshAudience({ listenerIds: listeners, cap });
      servedRef.current = served;
      setOverFanOut(meshSaturated({ listenerIds: listeners, cap }));
      setUnheard(!stageRef.current && stage > 0 && !served.has(userId));
      // Pair when either side is on the stage *and* the audience budget covers
      // that link; the lower id offers, so two sides never send an offer to each
      // other at the same moment.
      for (const id of others) {
        const they = !!roster.current.get(id)?.speaker;
        const needs = pairAllowedByAudience({
          me: userId,
          peer: id,
          meOnStage: stageRef.current,
          peerOnStage: they,
          served,
        });
        if (needs && !pcs.current.has(id) && initiatesPair(userId, id)) void connectTo(id);
        if (!needs && pcs.current.has(id)) closePeer(id);
        // Somebody just stepped up: their audio may already be arriving on a
        // connection we had no reason to play yet.
        const stream = remoteStreams.current.get(id);
        if (needs && they && stream && !audios.current.has(id)) attachPlayback(id, stream);
      }
      for (const id of [...pcs.current.keys()]) if (!roster.current.has(id)) closePeer(id);
      if (!others.length) setStatus("live");
    }
    syncRef.current = sync;

    channel
      .on("presence", { event: "sync" }, sync)
      .on("broadcast", { event: "signal" }, async ({ payload }) => {
        const msg = payload as Signal;
        if (msg.to !== userId) return;
        if (msg.kind === "reject") {
          // The other side's audience budget does not include us. Close the
          // half-built link instead of sitting in "connecting" forever; a later
          // presence change is what re-evaluates it, so this cannot loop.
          closePeer(msg.from);
          return;
        }
        // An offer from someone the mesh must not be paired with (a room caught
        // mid-flip, a tab running stale presence): refuse it rather than accept
        // an extra uplink the sender's own rules would drop a second later.
        // Only judged once presence has landed for both of us — until then the
        // sender's role is a guess, and `sync()` reconciles it moments later.
        const served = servedRef.current;
        if (
          msg.kind === "offer" &&
          served &&
          roster.current.has(msg.from) &&
          !pairAllowedByAudience({
            me: userId,
            peer: msg.from,
            meOnStage: stageRef.current,
            peerOnStage: !!roster.current.get(msg.from)?.speaker,
            served,
          })
        ) {
          await send({ kind: "reject", from: userId, to: msg.from }).catch(() => undefined);
          return;
        }
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

    void (async () => {
      if (sfuAdapter && appConfig.realtime.sfuProvider) {
        await sfuAdapter.join({ spaceId, userId, speaker }).catch(() => setStatus("error"));
        return;
      }
      channel.subscribe(async (s) => {
        if (s === "SUBSCRIBED") {
          await channel.track({ speaker: stageRef.current });
          sync();
        }
      });
    })();

    return () => {
      cancelled = true;
      channelRef.current = null;
      syncRef.current = null;
      negotiateRef.current = null;
      servedRef.current = null;
      [...roomPeers.current.keys()].forEach(closePeer);
      restartTimers.current.forEach((timer) => clearTimeout(timer));
      restartTimers.current.clear();
      void supabase.removeChannel(channel);
      setStatus("idle");
      setSpeakingIds(new Set());
      setNeedsGesture(false);
    };
    // No `speaker` here on purpose: the channel and every peer connection live
    // for the whole session, and a role change is carried by `replaceTrack`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, spaceId, userId, unlock]);

  // One tap anywhere is enough; after that the room keeps playing by itself.
  useEffect(() => {
    if (!needsGesture) return;
    const once = () => unlock();
    window.addEventListener("pointerdown", once);
    window.addEventListener("keydown", once);
    return () => {
      window.removeEventListener("pointerdown", once);
      window.removeEventListener("keydown", once);
    };
  }, [needsGesture, unlock]);

  // Full teardown when the room closes: tracks, meters and the shared context.
  // (The microphone effect stops its own stream when a role changes.)
  useEffect(
    () => () => {
      levels.current.forEach((stop) => stop());
      levels.current.clear();
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
      if (recorder.current && recorder.current.state !== "inactive") {
        try {
          recorder.current.stop();
        } catch {
          /* ignore */
        }
      }
      recorder.current = null;
      try {
        silentNodes.current?.osc.stop();
      } catch {
        /* ignore */
      }
      silentNodes.current = null;
      silentTrack.current = null;
      outgoing.current = null;
      try {
        void audioCtx.current?.close();
      } catch {
        /* ignore */
      }
      audioCtx.current = null;
      mixDest.current = null;
      mixed.current = new Set();
      sfuAdapter?.leave();
    },
    // Runs once per mount: every value it releases lives in a ref.
    [],
  );

  return {
    status,
    peers,
    speakingIds,
    overCapacity,
    overFanOut,
    unheard,
    needsGesture,
    unlock,
    startRecording,
    stopRecording,
    isRecordingLocally,
    recordingBytes,
  };
}
