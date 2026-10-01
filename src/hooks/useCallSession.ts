import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  CALL_UI_SIGNALS,
  canApplyAnswer,
  classifyQuality,
  selectAudioSender,
  selectVideoTransceiver,
  shouldIgnoreIncomingOffer,
  videoEncodeHint,
  type CallQuality,
  type OutgoingVideoKind,
} from "@/lib/call-media";
import { buildIceServers } from "@/lib/webrtc/ice";
import type { CallKind } from "@/lib/calls";

export type ConnectionState = "idle" | "connecting" | "connected" | "failed" | "closed";

/** What the other person's controls look like from this side. */
export interface PeerMediaState {
  camera: boolean;
  share: boolean;
  muted: boolean;
}

export type CallSignalPayload = Record<string, unknown>;
export type CallSignalHandler = (payload: CallSignalPayload) => void;

interface Options {
  callId: string | null;
  /** The caller creates the offer; the callee answers it. */
  role: "caller" | "callee";
  kind: CallKind;
  /** Only start negotiating once the callee has picked up. */
  enabled: boolean;
}

/**
 * `call_signals` is newer than the generated Database types (typegen is an M4
 * task), and the previous workaround was `(supabase as any)`, which silenced the
 * compiler *and* the failure it was meant to guard. This declares only the two
 * queries the hook actually runs.
 */
interface CallSignalClient {
  from(table: "call_signals"): {
    insert(values: {
      call_id: string;
      kind: "offer" | "answer";
      payload: unknown;
    }): PromiseLike<{ error: { message: string } | null }>;
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        order(column: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * The session's actions. They are built inside the connect effect, because that
 * is where the peer connection and its tracks live, but they must keep a
 * *stable* identity for React: an effect that depended on the whole `session`
 * object used to re-run on every render, which is how a mute tap could fire
 * hundreds of times in one call.
 */
interface CallControls {
  setMic: (on: boolean) => void;
  setCamera: (on: boolean) => Promise<void>;
  startShare: () => Promise<boolean>;
  stopShare: () => Promise<void>;
  selectCamera: (deviceId: string) => Promise<void>;
  selectMicrophone: (deviceId: string) => Promise<void>;
}

const NO_CONTROLS: CallControls = {
  setMic: () => {},
  setCamera: async () => {},
  startShare: async () => false,
  stopShare: async () => {},
  selectCamera: async () => {},
  selectMicrophone: async () => {},
};

const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Reads the two numbers that describe how bad the link actually is. */
interface PairStats {
  type?: string;
  selected?: boolean;
  inUse?: boolean;
  currentRoundTripTime?: number;
}

interface RtpStats {
  type?: string;
  kind?: string;
  packetsReceived?: number;
  packetsLost?: number;
}

export function useCallSession({ callId, role, kind, enabled }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [quality, setQuality] = useState<CallQuality>("unknown");
  const [sharing, setSharing] = useState(false);
  const [cameraOn, setCameraOn] = useState(kind === "video");
  const [micOn, setMicOn] = useState(true);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  /**
   * Are frames from their camera or desktop actually arriving right now? The
   * browser tells us (mute/unmute on the received track), which is evidence
   * rather than the announcement in `peerMedia` that a dropped broadcast can
   * leave stale.
   */
  const [remoteVideoLive, setRemoteVideoLive] = useState(false);
  const [peerMedia, setPeerMedia] = useState<PeerMediaState>({
    camera: kind === "video",
    share: false,
    muted: false,
  });

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const dbChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  /**
   * Microphone and camera only. The screen share never joins this stream, which
   * is the whole reason sharing used to break the call: the old code rewrote the
   * local stream with the display track, so the camera track was no longer
   * findable and "Stop sharing" handed the wire a null track.
   */
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const cleanedUp = useRef(false);
  const micOnRef = useRef(true);
  const cameraOnRef = useRef(kind === "video");
  const sharingRef = useRef(false);
  const restartingRef = useRef(false);
  const handlersRef = useRef(new Map<string, Set<CallSignalHandler>>());
  const controlsRef = useRef<CallControls>(NO_CONTROLS);

  // ---- signalling bus -------------------------------------------------------------
  // The call's private broadcast channel carries UI events next to the SDP, so
  // in-call chat and reactions reach exactly the two participants with no new
  // table and no new policy (the `call-signal-%` RLS in 20260925000009 matches
  // on the topic, not on the event name).
  const sendSignal = useCallback((event: string, payload: CallSignalPayload = {}) => {
    void channelRef.current?.send({ type: "broadcast", event, payload });
  }, []);

  const onSignal = useCallback((event: string, handler: CallSignalHandler) => {
    const set = handlersRef.current.get(event) ?? new Set<CallSignalHandler>();
    set.add(handler);
    handlersRef.current.set(event, set);
    return () => {
      set.delete(handler);
    };
  }, []);

  const publishMediaState = useCallback(() => {
    void channelRef.current?.send({
      type: "broadcast",
      event: "media",
      payload: {
        camera: cameraOnRef.current,
        share: sharingRef.current,
        muted: !micOnRef.current,
      },
    });
  }, []);

  // ---- teardown -------------------------------------------------------------------
  const cleanup = useCallback(() => {
    if (cleanedUp.current) return;
    cleanedUp.current = true;
    // The display stream is stopped explicitly. `replaceTrack(null)` leaves the
    // track alive, and a live screen track means the operating system keeps
    // showing "you are sharing your screen" after the call has ended.
    screenStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    screenStreamRef.current = null;
    setScreenStream(null);
    sharingRef.current = false;
    setSharing(false);
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
    cameraTrackRef.current = null;
    micTrackRef.current = null;
    controlsRef.current = NO_CONTROLS;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteHasVideo(false);
    setRemoteVideoLive(false);
    setConnection("closed");
  }, []);

  useEffect(() => {
    if (!callId || !enabled) return undefined;

    let cancelled = false;
    const disposables: Array<() => void> = [];
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
        const track = event.track;
        // One MediaStream object for the life of the call. `addTrack` mutates it
        // and the bound <video> picks the new track up by itself; rebuilding it
        // per track event changed the identity, so every consumer re-assigned
        // `srcObject`, and each re-assignment restarts decoding. That restart is
        // the flicker people saw whenever anything renegotiated.
        for (const t of event.streams[0]?.getTracks() ?? []) {
          if (!remote.getTracks().includes(t)) remote.addTrack(t);
        }
        if (!remote.getTracks().includes(track)) remote.addTrack(track);

        if (track.kind === "video") {
          // This call carries one video channel: camera OR share, never both. When
          // a renegotiated m-line hands us a fresh track, the previous one can still
          // be sitting in the stream, and the bound <video> keeps painting whichever
          // track it picked first — a frozen last frame that reads as a broken
          // camera. Anything already here is the older picture; drop it.
          for (const stale of remote.getVideoTracks()) {
            if (stale !== track) remote.removeTrack(stale);
          }
          setRemoteHasVideo(true);
          setRemoteVideoLive(true);
          // They turned the lens off (or stopped sharing) by putting a null track
          // on the sender: our copy of it goes mute. Trust that over the flag.
          track.onmute = () => setRemoteVideoLive(false);
          track.onunmute = () => setRemoteVideoLive(true);
          track.onended = () => {
            remote.removeTrack(track);
            setRemoteHasVideo(remote.getVideoTracks().some((t) => t.readyState === "live"));
            setRemoteVideoLive(false);
          };
        }
      };

      // ---- perfect negotiation ---------------------------------------------------
      // Mid-call screen sharing is exactly what this exists for. Both people can
      // renegotiate in the same instant (one adds a share while the other is still
      // answering the first offer), and without one side backing down the two
      // offers collide, a peer connection lands in a broken signalling state and
      // the share never appears.
      const polite = role === "callee";
      let makingOffer = false;
      let queueOffer = false;
      let lastOfferSent = "";
      let lastAnswerSent = "";
      let lastOfferApplied = "";
      let lastAnswerApplied = "";
      // The `call_signals` table exists for one reason: a peer that subscribes
      // after the first broadcast must still find the handshake. Once the two
      // sides are actually connected, a renegotiation belongs to the live channel
      // only - writing every camera and screen-share swap would grow the table
      // with kilobytes of SDP nobody replays, and each row came back on our own
      // change feed as an offer apparently sent by the other side.
      let connectedOnce = false;

      const send = (event: string, payload: unknown) =>
        channelRef.current?.send({ type: "broadcast", event, payload });

      /** Durable write of an SDP blob into `call_signals` (plan §9). Broadcast is
       * kept for latency, but a peer that subscribes late would otherwise miss the
       * offer; the table is the guarantee. `from_profile` is stamped by a DB
       * trigger, so the client never supplies an identity. */
      const persist = (which: "offer" | "answer", sdp: unknown) => {
        if (connectedOnce) return;
        const client = supabase as unknown as CallSignalClient;
        void client
          .from("call_signals")
          .insert({ call_id: callId, kind: which, payload: { sdp } })
          .then(({ error }) => {
            // supabase-js resolves with an `error` instead of throwing, so this
            // "guarantee for late joiners" used to fail invisibly: the peer that
            // subscribed late found no offer and the call never connected.
            if (error) console.error(`call ${which} not stored:`, error.message);
          });
      };

      async function negotiate(options?: { iceRestart?: boolean }) {
        if (makingOffer) {
          // A swap that arrived mid-offer still has to go out; retry the moment
          // the current one settles.
          queueOffer = true;
          return;
        }
        makingOffer = true;
        try {
          const offer = await pc.createOffer(options);
          // Re-sending the identical offer would only teach the peer to answer it
          // twice; an ICE restart always goes out.
          if (!options?.iceRestart && offer.sdp === lastOfferSent) return;
          await pc.setLocalDescription(offer);
          lastOfferSent = offer.sdp ?? "";
          persist("offer", offer);
          send("offer", { sdp: offer });
        } catch (err) {
          console.error("call negotiation failed:", err instanceof Error ? err.message : err);
        } finally {
          makingOffer = false;
          if (queueOffer && !cancelled) {
            queueOffer = false;
            await negotiate();
          }
        }
      }

      pc.onnegotiationneeded = () => {
        void negotiate();
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

      async function handleOffer(sdp: RTCSessionDescriptionInit | undefined) {
        // The same SDP can arrive twice (live broadcast + durable replay); dedupe
        // on the raw description so we never renegotiate against an applied one.
        if (!sdp?.sdp || sdp.sdp === lastOfferApplied) return;
        if (shouldIgnoreIncomingOffer({ polite, makingOffer, signalingState: pc.signalingState })) {
          // The polite side has already backed down from its own offer and will
          // re-offer once ours is answered.
          return;
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ ...sdp, type: "offer" }));
          lastOfferApplied = sdp.sdp;
          await flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          lastAnswerSent = answer.sdp ?? "";
          send("answer", { sdp: answer });
          persist("answer", answer);
        } catch (err) {
          console.error("call answer failed:", err instanceof Error ? err.message : err);
        }
      }

      async function handleAnswer(sdp: RTCSessionDescriptionInit | undefined) {
        if (!sdp?.sdp || sdp.sdp === lastAnswerApplied) return;
        if (!canApplyAnswer({ signalingState: pc.signalingState })) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ ...sdp, type: "answer" }));
          lastAnswerApplied = sdp.sdp;
          await flushCandidates();
          restartingRef.current = false;
        } catch {
          // A newer offer can make an in-flight answer stale; the answer for the
          // offer the peer actually holds is the one that lands next.
        }
      }

      const channel = supabase.channel(`call-signal-${callId}`, {
        // private:true → realtime.messages RLS (20260925000009) restricts the
        // 1:1 call signalling channel to the two participants + staff.
        config: { broadcast: { self: false }, private: true },
      });
      channelRef.current = channel;

      pc.onicecandidate = (event) => {
        if (event.candidate) void send("ice", { from: role, candidate: event.candidate.toJSON() });
      };

      channel
        .on("broadcast", { event: "offer" }, ({ payload }) => void handleOffer(payload?.sdp))
        .on("broadcast", { event: "answer" }, ({ payload }) => void handleAnswer(payload?.sdp))
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
        // Everything a user *sees* (chat, reactions, camera/share state) rides the
        // same private channel and fans out to whoever is listening for it.
        .on("broadcast", { event: "*" }, (message) => {
          const event = (message as { event?: string })?.event;
          const payload = (message as { payload?: unknown })?.payload;
          if (!event || !(CALL_UI_SIGNALS as readonly string[]).includes(event)) return;
          if (typeof payload !== "object" || payload === null) return;
          if (event === "media") {
            const p = payload as Partial<PeerMediaState>;
            setPeerMedia((prev) => ({
              camera: typeof p.camera === "boolean" ? p.camera : prev.camera,
              share: typeof p.share === "boolean" ? p.share : prev.share,
              muted: typeof p.muted === "boolean" ? p.muted : prev.muted,
            }));
            return;
          }
          const set = handlersRef.current.get(event);
          if (set) {
            for (const handler of [...set]) handler(payload as CallSignalPayload);
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
                const sdp = row.payload?.sdp;
                // Our own durable write comes back on this same feed. Applying it
                // would put us in have-remote-offer against an offer we are still
                // waiting to be answered, which dead-ends the call.
                if (!sdp?.sdp || sdp.sdp === lastOfferSent || sdp.sdp === lastAnswerSent) return;
                if (row.kind === "offer") void handleOffer(sdp);
                else if (row.kind === "answer") void handleAnswer(sdp);
              },
            )
            .subscribe();
          dbChannelRef.current = dbChannel;

          await acquireInitialMedia();
          if (cancelled) return;

          if (role === "caller") {
            // `onnegotiationneeded` normally fires once the tracks land. Offer
            // explicitly as well so a call still rings when media was denied and
            // no track will ever trigger it (negotiate() drops a repeat offer).
            await negotiate();
          } else {
            // Callee: pull any offer that was written before it joined. This is
            // the exact race that used to make calls never connect (plan §9).
            const client = supabase as unknown as CallSignalClient;
            const { data } = await client
              .from("call_signals")
              .select("kind, payload")
              .eq("call_id", callId)
              .order("id");
            for (const row of (data ?? []) as Array<{
              kind: string;
              payload?: { sdp?: RTCSessionDescriptionInit };
            }>) {
              if (row.kind === "offer" && row.payload?.sdp?.sdp !== lastOfferSent) {
                await handleOffer(row.payload?.sdp);
              }
            }
            void send("ready", {});
          }
          publishMediaState();
        });

      /**
       * Ask for the microphone and the camera separately. One combined request
       * meant a denied camera permission killed the whole call: the user could not
       * even talk, and the message blamed "camera or microphone".
       */
      async function acquireInitialMedia() {
        let audio: MediaStream | null = null;
        try {
          audio = await navigator.mediaDevices.getUserMedia({
            audio: MICROPHONE_CONSTRAINTS,
            video: false,
          });
        } catch {
          setMediaError("We couldn't reach your microphone. Check your browser permissions.");
        }
        if (cancelled) {
          audio?.getTracks().forEach((t) => t.stop());
          return;
        }

        const stream = new MediaStream();
        const mic = audio?.getAudioTracks()[0] ?? null;
        if (mic) {
          mic.enabled = micOnRef.current;
          micTrackRef.current = mic;
          stream.addTrack(mic);
        }

        if (kind === "video") {
          const camera = await openCameraTrack();
          if (cancelled) {
            camera?.stop();
          } else if (camera) {
            camera.enabled = cameraOnRef.current;
            cameraTrackRef.current = camera;
            stream.addTrack(camera);
          } else {
            cameraOnRef.current = false;
            setCameraOn(false);
            setMediaError(
              "We couldn't reach your camera, so this is a voice call. Check your browser permissions.",
            );
          }
        }

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        localStreamRef.current = stream;
        setLocalStream(stream);
        // Tracks go on before any offer exists, so they arrive in one media group
        // and the peers only have to agree on one negotiation.
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        if (!stream.getTracks().length) {
          setMediaError("No microphone or camera available, so the other side can't hear you.");
        }
      }

      async function openCameraTrack(): Promise<MediaStreamTrack | null> {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: CAMERA_CONSTRAINTS,
            audio: false,
          });
          const track = s.getVideoTracks()[0] ?? null;
          // A face is motion, not text: this is the hint that makes the encoder
          // protect frame rate instead of smearing every movement into blocks.
          if (track) track.contentHint = videoEncodeHint("camera").contentHint;
          return track;
        } catch {
          return null;
        }
      }

      /**
       * The bitrate ceiling for one outgoing video stream.
       *
       * Untuned, a camera will spend whatever the link has and starve the
       * microphone, which is the call that sounds like a robot. Only an existing
       * encoding is touched (inventing one changes the m-line), and an engine that
       * refuses the parameters keeps streaming at its own defaults rather than
       * losing the video altogether.
       */
      async function tuneVideoSender(sender: RTCRtpSender | null, kind: OutgoingVideoKind) {
        if (!sender) return;
        const { maxBitrate, degradationPreference } = videoEncodeHint(kind);
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) return;
          await sender.setParameters({
            ...params,
            degradationPreference,
            encodings: params.encodings.map((encoding) => ({
              ...encoding,
              maxBitrate: encoding.maxBitrate ?? maxBitrate,
            })),
          });
        } catch {
          /* unsupported tuning: the browser's own congestion control still applies */
        }
      }
      /**
       * Puts a video track on the call's single video channel. Replacing an
       * existing one is instant and never renegotiates; going from "no video at
       * all" (or back to none) changes the m-line's direction, so that transition
       * is announced. Camera and screen share therefore always behave the same
       * way: one of them is live, the other is kept ready.
       */
      async function setVideoOnWire(track: MediaStreamTrack | null, hint: OutgoingVideoKind) {
        if (track) track.contentHint = videoEncodeHint(hint).contentHint;
        const transceiver = selectVideoTransceiver(pc.getTransceivers());
        const sender = transceiver?.sender ?? null;

        if (!sender) {
          if (!track) return;
          // The upgrade from a voice call: there is no video m-line yet, so the
          // track starts a new one. Waiting for `onnegotiationneeded` to do it is
          // the bug the other side feels as "I switched my camera on and they still
          // can't see me" — the event is not guaranteed to fire again once a
          // connection has already negotiated, so the offer is made explicitly.
          const stream = localStreamRef.current ?? new MediaStream([track]);
          if (!localStreamRef.current) {
            localStreamRef.current = stream;
            setLocalStream(stream);
          }
          const added = pc.addTrack(track, stream);
          await tuneVideoSender(added, hint);
          await negotiate();
          return;
        }

        // A video m-line the peer opened first is answered `recvonly`, and a
        // recvonly sender cannot carry our picture however many tracks we put on
        // it. Widen it, then renegotiate.
        if (track && transceiver && transceiver.direction === "recvonly") {
          try {
            transceiver.direction = "sendrecv";
          } catch {
            /* engines without a settable direction still re-offer below */
          }
        }

        const wasActive = !!sender.track;
        await sender.replaceTrack(track);
        if (track) await tuneVideoSender(sender, hint);
        if (wasActive !== !!track) await negotiate();
      }

      function stopScreenStream() {
        const stream = screenStreamRef.current;
        if (!stream) return false;
        screenStreamRef.current = null;
        setScreenStream(null);
        sharingRef.current = false;
        setSharing(false);
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        return true;
      }

      // ---- the actions CallModal drives ------------------------------------------
      const setMic = (on: boolean) => {
        micOnRef.current = on;
        setMicOn(on);
        const mic = micTrackRef.current ?? localStreamRef.current?.getAudioTracks()[0] ?? null;
        if (mic) mic.enabled = on;
        publishMediaState();
      };

      const setCamera = async (on: boolean) => {
        cameraOnRef.current = on;
        setCameraOn(on);
        if (!on) {
          cameraTrackRef.current ??=
            localStreamRef.current?.getVideoTracks().find((t) => !isShareTrack(t)) ?? null;
          if (cameraTrackRef.current) cameraTrackRef.current.enabled = false;
          // A disabled track keeps sending black frames and the receiver's browser
          // never fires `mute` on those, so the other person is left staring at a
          // dark rectangle instead of the avatar they were promised. Taking it off
          // the wire is what actually ends the picture — unless a screen share is
          // the thing using that channel, which the camera must not kill.
          if (!sharingRef.current) await setVideoOnWire(null, "camera");
          publishMediaState();
          return;
        }
        if (!cameraTrackRef.current) {
          const track = await openCameraTrack();
          if (!track) {
            cameraOnRef.current = false;
            setCameraOn(false);
            setMediaError("We couldn't reach your camera. Check your browser permissions.");
            publishMediaState();
            return;
          }
          track.enabled = true;
          cameraTrackRef.current = track;
          localStreamRef.current?.addTrack(track);
          syncLocalStream();
        } else {
          cameraTrackRef.current.enabled = true;
        }
        // The camera takes the video channel back from a live share rather than
        // leaving somebody's desktop running unseen behind it.
        const wasSharing = stopScreenStream();
        await setVideoOnWire(cameraTrackRef.current, "camera");
        if (wasSharing) void negotiate();
        publishMediaState();
      };

      const startShare = async () => {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          setMediaError("Screen sharing isn't supported in this browser.");
          return false;
        }
        if (screenStreamRef.current) return true;
        let stream: MediaStream | null = null;
        try {
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
              audio: false,
            });
          } catch {
            // Older Safari rejects unknown constraint shapes; a bare request is
            // always understood.
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          }
        } catch {
          // The picker was dismissed or denied. That is somebody changing their
          // mind, not a fault to shout about.
          return false;
        }
        if (cancelled) {
          stream?.getTracks().forEach((t) => t.stop());
          return false;
        }
        const track = stream?.getVideoTracks()[0] ?? null;
        if (!track || !stream) return false;
        // "detail" tells the encoder to protect text sharpness over frame rate —
        // the difference between a readable slide and a watercolour smear.
        track.contentHint = videoEncodeHint("screen").contentHint;
        // The browser's own Stop button has to put the camera back, or the peer is
        // left staring at the last frame of somebody's desktop.
        track.onended = () => void stopShare();
        screenStreamRef.current = stream;
        setScreenStream(stream);
        sharingRef.current = true;
        setSharing(true);
        await setVideoOnWire(track, "screen");
        publishMediaState();
        return true;
      };

      const stopShare = async () => {
        if (!stopScreenStream()) return;
        const camera = cameraTrackRef.current;
        await setVideoOnWire(cameraOnRef.current && camera ? camera : null, "camera");
        publishMediaState();
      };

      const selectCamera = async (deviceId: string) => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: { ...CAMERA_CONSTRAINTS, deviceId: { exact: deviceId } },
            audio: false,
          });
          const next = s.getVideoTracks()[0];
          if (!next) return;
          const prev = cameraTrackRef.current;
          next.enabled = cameraOnRef.current;
          cameraTrackRef.current = next;
          // New track in before the old one leaves. Removing first can leave the
          // preview element with no video track to select, and it paints black
          // until the next one lands - a flash the user reads as a bad call.
          localStreamRef.current?.addTrack(next);
          if (prev) {
            prev.enabled = false;
            localStreamRef.current?.removeTrack(prev);
          }
          syncLocalStream();
          prev?.stop();
          // Swapping cameras must not steal the channel from a live share.
          if (!sharingRef.current) await setVideoOnWire(next, "camera");
        } catch {
          setMediaError("That camera isn't available. It may have been unplugged.");
        }
      };

      const selectMicrophone = async (deviceId: string) => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            audio: { ...MICROPHONE_CONSTRAINTS, deviceId: { exact: deviceId } },
            video: false,
          });
          const next = s.getAudioTracks()[0];
          if (!next) return;
          const prev = micTrackRef.current;
          next.enabled = micOnRef.current;
          micTrackRef.current = next;
          localStreamRef.current?.addTrack(next);
          if (prev) localStreamRef.current?.removeTrack(prev);
          syncLocalStream();
          prev?.stop();
          const sender = selectAudioSender(pc.getSenders());
          await sender?.replaceTrack(next);
        } catch {
          setMediaError("That microphone isn't available. It may have been unplugged.");
        }
      };

      /**
       * Keeps React's view of the local stream in step with the one on the wire.
       *
       * It deliberately does not build a new MediaStream: the object identity is
       * what the preview <video> is bound to, and swapping it re-attaches
       * `srcObject`, which restarts playback. The stream is mutated in place as
       * cameras and microphones are swapped, so the preview follows the track
       * without ever going black.
       */
      function syncLocalStream() {
        const stream = localStreamRef.current;
        if (stream) setLocalStream(stream);
      }

      controlsRef.current = {
        setMic,
        setCamera: async (on) => void setCamera(on),
        startShare,
        stopShare: async () => void stopShare(),
        selectCamera: async (id) => void selectCamera(id),
        selectMicrophone: async (id) => void selectMicrophone(id),
      };

      pc.onconnectionstatechange = () => {
        if (cancelled) return;
        const state = pc.connectionState;
        if (state === "connected") {
          setConnection("connected");
          restartingRef.current = false;
          connectedOnce = true;
          // A broadcast sent while the socket was down is simply gone, so the
          // other side re-syncs its camera/share state on every (re)connect.
          publishMediaState();
        } else if (state === "failed") {
          // One ICE restart before giving up — flaky wifi and NAT rebinds usually
          // recover this way without dropping the call. Either side may restart now;
          // the collision rule keeps the two from fighting over it.
          if (!restartingRef.current) {
            restartingRef.current = true;
            void negotiate({ iceRestart: true });
          } else {
            setConnection("failed");
          }
        } else if (state === "disconnected") {
          // Held open: ICE usually re-gathers on its own within a second or two,
          // and a call that announces "closed" while it is still talking is worse
          // than one that says "connecting".
          setConnection("connecting");
        } else if (state === "closed") {
          setConnection("closed");
        }
      };

      const onOnline = () => publishMediaState();
      window.addEventListener("online", onOnline);
      disposables.push(() => window.removeEventListener("online", onOnline));
    })();

    // Clean teardown if the tab/browser closes mid-call.
    const handleUnload = () => cleanup();
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
      for (const off of disposables) off();
      disposables.length = 0;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, enabled, kind, role]);

  // ---- link quality ---------------------------------------------------------------
  // A 3s poll of the selected candidate pair. The chip only appears when the
  // numbers say something is wrong, so a healthy call never asks the user to
  // interpret a graph.
  useEffect(() => {
    if (connection !== "connected") {
      if (connection === "idle" || connection === "closed") setQuality("unknown");
      return undefined;
    }
    let stopped = false;

    async function sample() {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        // Collected into arrays rather than assigned from inside the callback:
        // a `let` written in a closure is exactly the shape TypeScript refuses to
        // track, and the bug it hides is a quality chip that never updates.
        const pairs: PairStats[] = [];
        const inbound: RtpStats[] = [];
        stats.forEach((report) => {
          const row = report as unknown as PairStats & RtpStats;
          if (row.type === "candidate-pair" && (row.selected || row.inUse)) pairs.push(row);
          if (row.type === "inbound-rtp" && typeof row.packetsReceived === "number") {
            inbound.push(row);
          }
        });
        // Video is the fragile stream; judge the call by it when there is one,
        // otherwise by the audio the call is actually running on.
        const stream = inbound.find((r) => r.kind === "video") ?? inbound[0] ?? null;
        const rttSeconds = pairs
          .map((p) => p.currentRoundTripTime)
          .find((value): value is number => typeof value === "number");
        const rttMs = typeof rttSeconds === "number" ? Math.round(rttSeconds * 1000) : null;
        const received = stream?.packetsReceived ?? 0;
        const lost = Math.max(0, stream?.packetsLost ?? 0);
        const lossRatio = received + lost > 0 ? lost / (received + lost) : null;
        if (!stopped) setQuality(classifyQuality({ rttMs, lossRatio }));
      } catch {
        /* getStats can fail mid-teardown */
      }
    }

    void sample();
    const timer = setInterval(() => void sample(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connection]);

  const setMicEnabled = useCallback((on: boolean) => controlsRef.current.setMic(on), []);
  const setCameraEnabled = useCallback((on: boolean) => void controlsRef.current.setCamera(on), []);
  const startScreenShare = useCallback(() => controlsRef.current.startShare(), []);
  const stopScreenShare = useCallback(() => void controlsRef.current.stopShare(), []);
  const switchCamera = useCallback(
    (deviceId: string) => void controlsRef.current.selectCamera(deviceId),
    [],
  );
  const switchMicrophone = useCallback(
    (deviceId: string) => void controlsRef.current.selectMicrophone(deviceId),
    [],
  );

  return {
    localStream,
    screenStream,
    remoteStream,
    connection,
    quality,
    mediaError,
    sharing,
    cameraOn,
    micOn,
    remoteHasVideo,
    remoteVideoLive,
    peerMedia,
    sendSignal,
    onSignal,
    setMicEnabled,
    setCameraEnabled,
    startScreenShare,
    stopScreenShare,
    switchCamera,
    switchMicrophone,
    hangUp: cleanup,
  };
}

/** `displaySurface` is only set on a track that came from getDisplayMedia. */
function isShareTrack(track: MediaStreamTrack): boolean {
  try {
    return !!track.getSettings().displaySurface;
  } catch {
    return false;
  }
}
