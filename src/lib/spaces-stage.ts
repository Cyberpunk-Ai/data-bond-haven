/**
 * Who may talk in a Space, and who only listens.
 *
 * The rule the room runs on: the stage (host + the speakers the host invites)
 * is the only thing that is broadcast. A listener receives audio and never
 * publishes any — no microphone is even requested on their device, so joining,
 * scrolling or tapping around cannot interrupt the room for anybody else.
 *
 * These decisions live here, apart from WebRTC, because they are the part that
 * must not drift: the UI, the mesh and the tests all read the same rules, and
 * the database enforces the same boundary (t_space_participants_role_guard in
 * 20260924000050 rejects a self-promotion).
 */

export type StageRole = "host" | "speaker" | "listener";

const STAGE: readonly string[] = ["host", "speaker"];

/** Normalise anything the roster/DB gives us into one of the three roles. */
export function asStageRole(role: unknown): StageRole {
  return role === "host" || role === "speaker" ? role : "listener";
}

/** On the stage: their microphone is what the room hears. */
export function isOnStage(role: unknown): boolean {
  return STAGE.includes(asStageRole(role));
}

/**
 * May this participant transmit audio? Only the stage, and only while the
 * subsystem is on — a listener is never allowed to publish, whatever their
 * local UI state says.
 */
export function canBroadcast(role: unknown): boolean {
  return isOnStage(role);
}

/**
 * Should a peer connection exist between two participants? A link is only
 * worth setting up when at least one side has something to say: two listeners
 * have nothing to exchange, so they never connect and never load the room.
 */
export function shouldPair(meOnStage: boolean, otherOnStage: boolean): boolean {
  return meOnStage || otherOnStage;
}

/**
 * Both sides of a new pair want to create it, so exactly one of them offers.
 * The lower participant id initiates — a stable, symmetric tie-break that
 * avoids the SDP glare (two simultaneous offers) which otherwise shows up as
 * audio that connects for one person and never for the other.
 */
export function initiatesPair(meId: string, otherId: string): boolean {
  return meId < otherId;
}

/**
 * Mute a participant starts on when they open the room. The host is broadcasting
 * a live room, so their microphone comes on; an invited speaker has accepted the
 * floor; a listener has nothing to say yet and must not be prompted for mic
 * access at all.
 */
export function initialMutedFor(role: unknown): boolean {
  return !isOnStage(role);
}

/**
 * Tapping the microphone button changes mic state only — never the role. A
 * previous version promoted a listener to "speaker" locally, which let anyone
 * broadcast to the room while the database still had them as a listener.
 */
export function roleAfterMicToggle(role: unknown): StageRole {
  return asStageRole(role);
}

/** What a role flip from the host means for the local microphone. */
export function micStateAfterRoleChange(nextRole: unknown): { onStage: boolean; muted: boolean } {
  const onStage = isOnStage(nextRole);
  return { onStage, muted: !onStage };
}

/** More than this many live microphones and the mesh stops staying in sync. */
export function isOverCapacity(stageCount: number, max: number): boolean {
  return stageCount > max;
}

/**
 * The other ceiling the mesh has, and the one that actually bites first.
 *
 * `isOverCapacity` counts microphones, but a room of 3 speakers and 250 listeners
 * never trips it — while every speaker is pushing one encoded, live uplink to all
 * 250 of them. Bandwidth is spent per *pair*, and the pair that costs is
 * speaker→listener. So the audience is budgeted exactly like the stage is.
 *
 * The budget has to be spent identically in two browsers that only exchange
 * presence, so the choice is derived from the participant id (which both sides
 * can sort), never from join order or arrival time (which differ per tab). That
 * is what keeps a decision from flapping: a listener is either inside the
 * audience on both ends, or outside it on both.
 */

/** Sorted, de-duplicated: the canonical order every device agrees on. */
export function sortedRoomIds(ids: Iterable<string>): string[] {
  return Array.from(new Set(ids)).sort();
}

/**
 * Which listeners the stage will hold live uplinks for. The room keeps serving
 * them first because the ordering is stable — a listener who is heard stays
 * heard while the room's composition doesn't churn.
 */
export function meshAudience(opts: { listenerIds: Iterable<string>; cap: number }): Set<string> {
  const listeners = sortedRoomIds(opts.listenerIds);
  if (opts.cap <= 0) return new Set();
  return new Set(listeners.slice(0, Math.floor(opts.cap)));
}

/** Is this room bigger than the mesh can carry? (Somebody is not being served.) */
export function meshSaturated(opts: { listenerIds: Iterable<string>; cap: number }): boolean {
  return sortedRoomIds(opts.listenerIds).length > Math.floor(opts.cap);
}

/**
 * May a peer connection exist between these two participants?
 *
 * Stage↔stage always pairs (that link is what a panel hears itself in, and the
 * stage is capped by `maxMeshSpeakers`). Two listeners never pair — nothing to
 * exchange. A speaker↔listener link is the expensive direction, so it is the one
 * the audience budget decides, and it answers the same way whichever side asks.
 */
export function meshPairAllowed(opts: {
  me: string;
  peer: string;
  meOnStage: boolean;
  peerOnStage: boolean;
  listenerIds: Iterable<string>;
  cap: number;
}): boolean {
  return pairAllowedByAudience({ ...opts, served: meshAudience(opts) });
}

/**
 * The same decision against an audience that was worked out once — a room's
 * pairing loop calls this per peer, and slicing/sorting the listener list every
 * time is O(n²) work on a thread that is also decoding audio.
 */
export function pairAllowedByAudience(opts: {
  me: string;
  peer: string;
  meOnStage: boolean;
  peerOnStage: boolean;
  served: ReadonlySet<string>;
}): boolean {
  // Nothing to exchange, no link — the rule the room has always run on.
  if (!shouldPair(opts.meOnStage, opts.peerOnStage)) return false;
  // Panel links are cheap (the stage is capped by maxMeshSpeakers) and a
  // speaker who cannot hear the other speakers sounds broken, so they are free.
  if (opts.meOnStage && opts.peerOnStage) return true;
  // The expensive direction: one live encoder and one uplink per listener.
  return opts.served.has(opts.meOnStage ? opts.peer : opts.me);
}
