import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  asStageRole,
  canBroadcast,
  initialMutedFor,
  initiatesPair,
  isOnStage,
  isOverCapacity,
  micStateAfterRoleChange,
  roleAfterMicToggle,
  shouldPair,
} from "@/lib/spaces-stage";

/**
 * The one rule a Space lives or dies by: only the stage (host + the speakers the
 * host invited) is broadcast, and everybody else listens without disturbing it.
 *
 * These functions are what the room, the mesh and the database all agree on, so
 * they are tested as rules rather than through a browser. Two regressions this
 * pins down are ones that actually shipped: tapping the microphone used to
 * promote the tapper to "speaker", and that role was a dependency of the whole
 * WebRTC channel — so one person's mute click dropped everyone else's audio for
 * a moment.
 */
describe("stage roles decide who is broadcast", () => {
  it("lets the host and invited speakers transmit", () => {
    expect(canBroadcast("host")).toBe(true);
    expect(canBroadcast("speaker")).toBe(true);
  });

  it("keeps every listener off the air", () => {
    expect(canBroadcast("listener")).toBe(false);
    expect(isOnStage("listener")).toBe(false);
  });

  it("treats anything it does not recognise as an audience member", () => {
    // Fail closed: a role the schema has never heard of must not hand somebody
    // a microphone.
    for (const junk of [undefined, null, "", "HOST", "moderator", 0, 1, {}, []]) {
      expect(asStageRole(junk)).toBe("listener");
      expect(canBroadcast(junk)).toBe(false);
    }
    expect(asStageRole("speaker")).toBe("speaker");
  });

  it("opens the room with the host live and the audience silent", () => {
    expect(initialMutedFor("host")).toBe(false);
    expect(initialMutedFor("speaker")).toBe(false);
    expect(initialMutedFor("listener")).toBe(true);
  });

  it("never lets the microphone button change somebody's station", () => {
    expect(roleAfterMicToggle("listener")).toBe("listener");
    expect(roleAfterMicToggle("speaker")).toBe("speaker");
    expect(roleAfterMicToggle("host")).toBe("host");
    // The bug this guards: an unmute used to return "speaker" for a listener.
    expect(roleAfterMicToggle("listener")).not.toBe("speaker");
  });

  it("makes the microphone follow a role the host handed over or took back", () => {
    expect(micStateAfterRoleChange("speaker")).toEqual({ onStage: true, muted: false });
    expect(micStateAfterRoleChange("listener")).toEqual({ onStage: false, muted: true });
    expect(micStateAfterRoleChange(undefined)).toEqual({ onStage: false, muted: true });
  });
});

describe("peer links only exist where there is something to hear", () => {
  it("pairs a listener with the stage, and never listener to listener", () => {
    expect(shouldPair(true, false)).toBe(true); // stage member ↔ audience
    expect(shouldPair(false, true)).toBe(true); // audience ↔ stage member
    expect(shouldPair(true, true)).toBe(true); // two stage members
    expect(shouldPair(false, false)).toBe(false); // two listeners: nothing to exchange
  });

  it("has exactly one side of a pair offer, so nobody's audio collides", () => {
    // Simultaneous offers (glare) are how one person hears a speaker and the
    // next hears nothing at all, so the tie-break must be antisymmetric.
    expect(initiatesPair("a", "b")).toBe(true);
    expect(initiatesPair("b", "a")).toBe(false);
    expect(initiatesPair("a", "a")).toBe(false);
    for (const [me, other] of [
      ["u1", "u2"],
      ["u2", "u1"],
      ["zz", "aa"],
      ["aa", "zz"],
    ]) {
      expect(initiatesPair(me, other)).not.toBe(initiatesPair(other, me));
    }
  });

  it("warns once the live microphones outgrow the mesh", () => {
    expect(isOverCapacity(8, 8)).toBe(false);
    expect(isOverCapacity(9, 8)).toBe(true);
    expect(isOverCapacity(1, 8)).toBe(false);
  });
});

describe("the room keeps the promise these rules make", () => {
  // Source-level, because the behaviour needs two browsers and a signalling
  // server to observe. Both assertions failed before this rework.
  const hook = readFileSync("src/hooks/useSpaceAudio.ts", "utf8");
  const modal = readFileSync("src/components/social/SpaceRoomModal.tsx", "utf8");

  it("keeps the signalling channel alive across a role change", () => {
    const mesh = hook.slice(hook.indexOf("// --- Channel and mesh"));
    const deps = mesh.match(/\}, \[([^\]]*enabled[^\]]*)\]\);/);
    expect(deps, "channel effect boundary not found").toBeTruthy();
    // `speaker` in this list would tear down the channel and every peer
    // connection whenever somebody gained or lost the floor.
    expect(deps![1]).not.toContain("speaker");
    expect(deps![1]).toContain("enabled");
    expect(hook).toContain("replaceTrack");
  });

  it("asks for the microphone only for the stage", () => {
    const micEffect = hook.slice(
      hook.indexOf("--- Microphone lifecycle"),
      hook.indexOf("// --- Channel and mesh"),
    );
    const guard = micEffect.slice(
      micEffect.indexOf("const onStage"),
      micEffect.indexOf("if (!onStage"),
    );
    expect(guard).toContain("stageRef.current");
    expect(guard).not.toContain("getUserMedia");
  });

  it("never rewrites a role from the microphone button", () => {
    const toggle = modal.slice(
      modal.indexOf("async function handleToggleMic"),
      modal.indexOf("async function handleToggleHand"),
    );
    expect(toggle).toContain("canBroadcast(myRole)");
    expect(toggle).not.toContain("setSpaceParticipantRole");
    expect(toggle).not.toContain('role: "speaker"');
  });

  it("offers a listener a raised hand instead of a microphone", () => {
    const bar = modal.slice(
      modal.indexOf("{!isReplay && ("),
      modal.indexOf('<div className="flex items-center gap-2 ml-auto">'),
    );
    expect(bar).toContain("canBroadcast(myRole) ? (");
    expect(bar).toContain("handleToggleHand");
    // The room must also say out loud when the browser is holding the audio back.
    expect(modal).toContain("audio.needsGesture");
    expect(modal).toContain("audio.unlock");
  });
});
