import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  meshAudience,
  meshPairAllowed,
  meshSaturated,
  pairAllowedByAudience,
  sortedRoomIds,
} from "@/lib/spaces-stage";

/**
 * Two ceilings a live Space has, both found while answering "how many listeners
 * can a Space hold?".
 *
 * 1. *Who may join* is a plan number (`plan_limits.spaces_max_listeners`: Free
 *    10, Plus 250, Pro 1,000) and the database enforces it — but it counted
 *    participant *rows*, and rows only left when a tab ran its React cleanup.
 *    Close the tab and the row stayed: it held a slot of the host's capacity, it
 *    kept the headcount high, and it kept the private signalling channel open
 *    for a person who had gone. `last_seen` + `space_heartbeat()` is the fix, so
 *    these tests pin the heartbeat down to the SQL that releases the slot.
 *
 * 2. *Who gets audio* was never bounded at all. A peer-to-peer room spends one
 *    encoder and one uplink per speaker–listener *pair*, so a room of 3 speakers
 *    and 250 listeners asks each speaker's browser to sustain ~16 Mbit/s of
 *    Opus — which fails as crackle and dropout for everybody, with no message.
 *    `meshAudience` puts the audience on a budget the same way the stage has
 *    always had one, and the shape of that budget is what the pure tests here
 *    lock down: identical on every device, or the two ends of a link disagree.
 */

const listeners = (n: number, pad = 2) =>
  Array.from({ length: n }, (_, i) => `l${String(i).padStart(pad, "0")}`);

describe("the audience budget is the same in every browser", () => {
  it("orders by participant id, never by who arrived first", () => {
    // Arrival order differs per tab (each device sees its own track first), so
    // a queue built from it would hand two browsers different answers about who
    // is heard — the exact flapping this rule exists to prevent.
    expect(sortedRoomIds(["b", "a", "c"])).toEqual(["a", "b", "c"]);
    expect(meshAudience({ listenerIds: ["z", "a", "m"], cap: 2 })).toEqual(new Set(["a", "m"]));
    expect(meshAudience({ listenerIds: ["a", "z", "m"], cap: 2 })).toEqual(new Set(["a", "m"]));
  });

  it("de-duplicates, because presence can report the same member twice", () => {
    expect(sortedRoomIds(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(meshAudience({ listenerIds: ["a", "a"], cap: 1 })).toEqual(new Set(["a"]));
  });

  it("serves up to the cap and no further", () => {
    const room = listeners(50);
    expect(meshAudience({ listenerIds: room, cap: 40 }).size).toBe(40);
    expect(meshAudience({ listenerIds: room, cap: 400 }).size).toBe(50);
    // A cap of zero means "no peer-to-peer audio at all" (an SFU is configured),
    // not "one listener" — and a negative knob must never widen the set.
    expect(meshAudience({ listenerIds: room, cap: 0 })).toEqual(new Set());
    expect(meshAudience({ listenerIds: room, cap: -5 })).toEqual(new Set());
  });

  it("says a room is saturated only when somebody is left out", () => {
    expect(meshSaturated({ listenerIds: listeners(40), cap: 40 })).toBe(false);
    expect(meshSaturated({ listenerIds: listeners(41), cap: 40 })).toBe(true);
    expect(meshSaturated({ listenerIds: [], cap: 40 })).toBe(false);
    expect(meshSaturated({ listenerIds: listeners(3), cap: 0 })).toBe(true);
  });
});

describe("links exist where the room can afford them", () => {
  const audience = listeners(5);

  it("never costs the stage a link to a listener it cannot feed", () => {
    const served = meshAudience({ listenerIds: audience, cap: 3 });
    for (const id of audience) {
      const allowed = pairAllowedByAudience({
        me: "s1",
        peer: id,
        meOnStage: true,
        peerOnStage: false,
        served,
      });
      expect(allowed).toBe(served.has(id));
    }
    expect([...audience].filter((id) => served.has(id))).toHaveLength(3);
  });

  it("answers the same question from both ends of the pair", () => {
    // Symmetry is the property that matters: if the speaker thinks a link is
    // affordable and the listener does not, one of them offers and the other
    // refuses, and the listener sits in a silent room blaming the host.
    const opts = (me: string, peer: string, meOnStage: boolean, peerOnStage: boolean) => ({
      me,
      peer,
      meOnStage,
      peerOnStage,
      listenerIds: audience,
      cap: 3,
    });
    for (const id of audience) {
      const a = meshPairAllowed(opts("s1", id, true, false));
      const b = meshPairAllowed(opts(id, "s1", false, true));
      expect(a).toBe(b);
    }
  });

  it("keeps the two rules the room has always run on", () => {
    const served = meshAudience({ listenerIds: audience, cap: 3 });
    const link = (me: string, peer: string, meOnStage: boolean, peerOnStage: boolean) =>
      pairAllowedByAudience({ me, peer, meOnStage, peerOnStage, served });
    // Panel members always hear each other — a speaker who cannot hear the other
    // speakers sounds broken, and the stage is already capped by maxMeshSpeakers.
    expect(link("s1", "s2", true, true)).toBe(true);
    // Two listeners still have nothing to exchange, budget or not.
    expect(link("l00", "l01", false, false)).toBe(false);
  });

  it("treats an over-cap room as a decision, not a failure", () => {
    // The first 40 are fed; the rest are told (the banner) instead of left
    // guessing why the room is quiet.
    const big = listeners(45);
    const served = meshAudience({ listenerIds: big, cap: 40 });
    expect(served.has("l00")).toBe(true);
    expect(served.has("l44")).toBe(false);
    expect(
      meshPairAllowed({
        me: "l44",
        peer: "s1",
        meOnStage: false,
        peerOnStage: true,
        listenerIds: big,
        cap: 40,
      }),
    ).toBe(false);
  });

  it("keeps the whole room's queue inside the budget it was given", () => {
    // Nobody is dropped while the room fits: this is what makes a Free host's
    // 10 listeners behave exactly as it always did.
    const small = listeners(10);
    expect(meshAudience({ listenerIds: small, cap: 40 })).toEqual(new Set(small));
    expect(meshSaturated({ listenerIds: small, cap: 40 })).toBe(false);
    for (const id of small) {
      expect(
        meshPairAllowed({
          me: "s1",
          peer: id,
          meOnStage: true,
          peerOnStage: false,
          listenerIds: small,
          cap: 40,
        }),
      ).toBe(true);
    }
  });
});

describe("the room and the server both spend that budget", () => {
  // Source-level: pairing needs two browsers, a signalling server and a wall
  // clock to observe, and all three are outside a test runner.
  const hook = readFileSync("src/hooks/useSpaceAudio.ts", "utf8");
  const api = readFileSync("src/lib/api-client.ts", "utf8");
  const modal = readFileSync("src/components/social/SpaceRoomModal.tsx", "utf8");
  const config = readFileSync("src/lib/config.ts", "utf8");
  const env = readFileSync(".env.example", "utf8");
  const presence = readFileSync("db/migrations/20261003000004_spaces_presence.sql", "utf8");

  it("budgets the audience where it builds every link", () => {
    const sync = hook.slice(
      hook.indexOf("function sync()"),
      hook.indexOf("syncRef.current = sync"),
    );
    expect(sync).toContain("meshAudience");
    expect(sync).toContain("pairAllowedByAudience");
    expect(sync).toContain("appConfig.realtime.maxMeshListeners");
    // …and refuses an offer the budget does not cover, rather than accepting a
    // link its own rules would close on the next presence tick.
    expect(hook).toContain('kind: "reject"');
    // The input is the whole roster: slicing a per-device list would make the
    // two ends disagree about who is inside the budget.
    expect(sync).toContain("roster.current.keys()");
    expect(sync).not.toContain("others.filter((id) => !roster.current.get(id)?.speaker)");
  });

  it("says out loud when the room outgrew the mesh", () => {
    expect(hook).toContain("overFanOut");
    expect(hook).toContain("unheard");
    expect(modal).toContain("audio.unheard");
    expect(modal).toContain("audio.overFanOut");
    expect(modal).toContain("maxMeshListeners");
  });

  it("makes the audience ceiling a deployment knob, documented where operators look", () => {
    expect(config).toMatch(/maxMeshListeners: num\("VITE_SPACES_MESH_LISTENERS", \d+\)/);
    expect(env).toContain("VITE_SPACES_MESH_LISTENERS=");
  });

  it("counts only people who are still saying so", () => {
    // The defect: capacity and headcount were spent on rows that a closed tab
    // had left behind, so rooms filled up with absentees.
    expect(presence).toMatch(/add column if not exists last_seen/);
    expect(presence).toContain("space_heartbeat");
    expect(/delete\s+from public\.space_participants/.test(presence)).toBe(true);
    expect(presence).toMatch(/last_seen > now\(\) - interval '3 minutes'/);
    // The host's own row must never be reaped or counted against their capacity.
    expect(presence).toContain("host_id");
  });

  it("beats from the room, not from a cleanup that a closed tab never runs", () => {
    expect(api).toContain('rpc("space_heartbeat"');
    expect(api).toContain("SPACE_HEARTBEAT_MS");
    expect(modal).toContain("spaceHeartbeat(space.id)");
    expect(modal).toContain("SPACE_HEARTBEAT_MS");
    // Joining stamps the row too: a member who never beats is swept like anybody
    // else, rather than being treated as absent from the second they arrived.
    expect(api).toMatch(/upsert\(\s*\{[^}]*last_seen: nowIso\(\)/s);
    // …and the headcount is read from the server rather than re-tallyed here.
    expect(api).toMatch(/from\("spaces"\)\s*\.select\("listeners"\)/s);
  });
});
