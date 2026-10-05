/**
 * Two contracts, both aimed at "why did my content vanish / why is the console
 * on fire":
 *
 *   1. The PostgREST 400 that used to fire on every inbox open. The browser
 *      filtered `hidden_for` server-side with `.not("hidden_for", "cs", [uuid])`,
 *      but supabase-js stringifies a JS array with `String([x])` — which for a
 *      single element yields just `x`, no `{}` wrapper. PostgREST rejected the
 *      bare uuid and returned 400, then the client's schema-cache fallback ran
 *      the same query without the filter. Every inbox open paid a 400 first,
 *      then a redundant second round trip.
 *
 *      Fix: move the exclusion into the RLS SELECT policy for `conversations`
 *      and `messages` (mirrors `calls participant read` from 20261004000003),
 *      delete the client-side filter. The wire query is now a plain SELECT,
 *      the database does the hide, and the browser stops 400-ing.
 *
 *   2. Uploaded bytes must never disappear. The legacy single-bucket policy
 *      and both split-bucket policies granted `authenticated` a DELETE (and
 *      UPDATE) on storage.objects, so a compromised client bundle or a
 *      careless reclaim could erase what a five-year-old message still
 *      points at. The api-client.ts delete paths also fired an opportunistic
 *      `deleteMyMedia` after a row delete, which turned "user removed their
 *      post" into "the image URL is now dead everywhere."
 *
 *      Fix: the migration drops DELETE + UPDATE for authenticated on every
 *      bucket (media, media-public, media-private). Insert and select stay —
 *      users keep uploading and reading. Service role (used by the admin
 *      storage adapter for future moderation) still bypasses RLS. And the
 *      api-client delete paths no longer reach for `deleteMyMedia`: a row
 *      delete leaves the bytes exactly where they were.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIG = src("../db/migrations/20261006000001_media_immutable_and_hide_rls.sql");
const API = src("../src/lib/api-client.ts");

describe("inbox hide is a policy, not a query string", () => {
  it("the migration extends conversations SELECT to exclude the reader's hidden list", () => {
    expect(MIG).toMatch(
      /create policy "conversations participant read"[\s\S]*?owns_profile\(user_a\)[\s\S]*?owns_profile\(user_b\)[\s\S]*?not \(hidden_for @> array\[auth\.uid\(\)\]\)/,
    );
  });

  it("the migration extends messages SELECT to exclude per-message AND per-conversation hides", () => {
    // Both clauses must be inside the same policy: a message inside a thread
    // the reader hid must disappear from the unread tally, and a per-message
    // tombstone (delete-for-me) must disappear from the thread view.
    const policy = MIG.slice(
      MIG.indexOf('create policy "messages participant read"'),
      MIG.indexOf("-- ---------- 2."),
    );
    expect(policy).toContain("not (c.hidden_for @> array[auth.uid()])");
    expect(policy).toContain("not (hidden_for @> array[auth.uid()])");
  });

  it("the browser no longer sends the malformed `not.cs.<uuid>` filter", () => {
    // The exact pattern that 400'd: `.not("hidden_for", "cs", [id])`. If this
    // ever comes back, the console 400s return too.
    expect(API).not.toMatch(/\.not\(\s*"hidden_for"\s*,\s*"cs"\s*,\s*\[/);
  });

  it("the client-side .filter fallback still stands as a belt for pre-migration reads", () => {
    // Schema-cache lag is real: a browser tab that already fetched the pre-
    // migration schema still gets hidden rows back. The in-code filter drops
    // them so a hidden thread does not light the badge.
    expect(API).toContain("!Array.isArray(r.hidden_for)");
    expect(API).toContain("r.hidden_for.includes(userId)");
  });
});

describe("uploaded bytes are immutable", () => {
  it("the migration revokes authenticated DELETE on every bucket", () => {
    // Legacy `media` bucket, plus the two split buckets from 20261001000099.
    expect(MIG).toContain('drop policy if exists "media owner delete" on storage.objects;');
    expect(MIG).toContain('drop policy if exists "media_public owner delete" on storage.objects;');
    expect(MIG).toContain('drop policy if exists "media_private owner delete" on storage.objects;');
  });

  it("the migration also revokes authenticated UPDATE so the URL cannot be renamed out from under a referrer", () => {
    expect(MIG).toContain('drop policy if exists "media owner update" on storage.objects;');
    expect(MIG).toContain('drop policy if exists "media_public owner update" on storage.objects;');
    expect(MIG).toContain('drop policy if exists "media_private owner update" on storage.objects;');
  });

  it("no create policy ... for delete|update to authenticated on storage.objects remains", () => {
    // Only drops, no new grants. If a future migration adds one back, the
    // assertion fires and forces the author to explain the exception.
    expect(MIG).not.toMatch(
      /create policy[\s\S]*?for (?:delete|update) to authenticated[\s\S]*?storage\.objects/,
    );
  });

  it("api-client never calls `deleteMyMedia` from a user-initiated delete path", () => {
    // The bytes must outlive the row. Post / story / message / recording
    // deletes all reach into the DB, none into storage.
    expect(API).not.toContain("deleteMyMedia");
    expect(API).not.toMatch(/from\s+"@\/lib\/media\.functions"/);
  });

  it("media functions is still exported for a future staff-only moderation entry", () => {
    // We are not deleting the server function, only the callers. A staff
    // action later should route through it explicitly (with a role check),
    // not through an implicit client-side sweep.
    const media = src("../src/lib/media.functions.ts");
    expect(media).toContain("export const deleteMyMedia");
  });

  it("finalize / delete recording keep the older bytes; only the row pointer moves", () => {
    // The pre-read used to grab the previous URL so it could be reclaimed.
    // Now nothing reads `spaces.recording_url` just to erase it.
    const fin = API.slice(
      API.indexOf("export async function finalizeSpaceRecording"),
      API.indexOf("export async function deleteSpaceRecording"),
    );
    expect(fin).not.toMatch(/from\("spaces"\)[\s\S]*?select\("recording_url"\)/);
    expect(fin).toContain("durability contract");
  });
});
