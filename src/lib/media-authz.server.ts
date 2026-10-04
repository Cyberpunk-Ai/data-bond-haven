/**
 * Media read authorization, in one place.
 *
 * The public media proxy (`/api/public/media/$`) and the signed-URL issuer
 * (`/api/media/token`) must agree *exactly* on who may read a private object.
 * A browser cannot attach an `Authorization` header to an `<audio>`/`<video>`/
 * `<img>` subresource load, so private media is served through a short-lived
 * signed URL instead - and that token is only worth having if it is minted
 * after the same check the proxy would have applied.
 */

import { visibilityOfPath } from "@/lib/media-folders.server";

export type MediaAccess = "public" | "private" | "unknown";

/**
 * Classify an object path by its leading folder, from the shared folder map
 * (src/lib/media-folders.server.ts) — the same map that decides which bucket
 * the object was written to, so a reader rule and a bucket placement can never
 * disagree. `stories` is addressed by a public URL but is only readable inside
 * the author's follow network, mirroring the rows' RLS policy on the bytes.
 */
export function classifyMediaPath(path: string): MediaAccess {
  const visibility = visibilityOfPath(path);
  if (visibility === null) return "unknown";
  return visibility === "public" ? "public" : "private";
}

interface MediaIdentity {
  profileId: string;
  authUserId: string;
}

/**
 * May this identity read `path`? Public folders are always yes; private ones
 * require a purpose-written rule, and anything unrecognised fails closed.
 */
export async function canReadMediaPath(
  path: string,
  identity: MediaIdentity | null,
): Promise<boolean> {
  const access = classifyMediaPath(path);
  if (access === "public") return true;
  if (access !== "private" || !identity) return false;

  const folder = path.split("/")[0];
  if (folder === "recordings") return isAuthorizedForRecording(path, identity);
  if (folder === "stories") return isAuthorizedForStoryMedia(path, identity);
  return isAuthorizedForMessageMedia(path, identity);
}

const mediaUrlFor = (path: string) => `/api/public/media/${path}`;

/**
 * Story media follows the `stories graph read` RLS rule: the author, staff,
 * and users in a direct follow relationship with the author (either
 * direction). The author is resolved from the object key (`stories/<profileId>/…`),
 * which the upload route mints from the verified caller — never from a header.
 */
async function isAuthorizedForStoryMedia(
  path: string,
  { profileId, authUserId }: MediaIdentity,
): Promise<boolean> {
  const segments = path.split("/");
  const authorId = segments[1];
  if (!authorId) return false;
  if (authorId === profileId) return true;

  const { adminDb } = await import("@/integrations/supabase/client.server");
  const db = adminDb();

  const { data: staff } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", authUserId)
    .in("role", ["admin", "moderator"])
    .maybeSingle();
  if (staff) return true;

  const { data: edge } = await db
    .from("follows")
    .select("follower_id")
    .or(
      `and(follower_id.eq.${profileId},target_id.eq.${authorId}),and(follower_id.eq.${authorId},target_id.eq.${profileId})`,
    )
    .limit(1)
    .maybeSingle();
  return Boolean(edge);
}

/**
 * A Space recording may only be read by the host who made it, or staff.
 * Recordings are the host's property — being in the room (or joining it as a
 * replay viewer) does not grant access to the bytes. The recording's URL is
 * stored on `spaces.recording_url`, so the owning Space is resolved from the
 * path and checked there rather than trusting the (auth-uid-namespaced)
 * folder segment.
 */
async function isAuthorizedForRecording(
  path: string,
  { profileId, authUserId }: MediaIdentity,
): Promise<boolean> {
  const { adminDb } = await import("@/integrations/supabase/client.server");
  const db = adminDb();

  const { data: space } = await db
    .from("spaces")
    .select("id, host_id")
    .eq("recording_url", mediaUrlFor(path))
    .maybeSingle();
  if (!space) {
    // Recording not (yet) attached to a Space row: fail closed. An unattached
    // object has no audience until finalizeSpaceRecording links the row.
    return false;
  }
  if (space.host_id === profileId) return true;

  const { data: staff } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", authUserId)
    .in("role", ["admin", "moderator"])
    .maybeSingle();
  return Boolean(staff);
}

/**
 * A private DM attachment may only be read by a participant (sender or
 * recipient) of a conversation that actually references it.
 */
async function isAuthorizedForMessageMedia(
  path: string,
  { profileId, authUserId }: MediaIdentity,
): Promise<boolean> {
  const { adminDb } = await import("@/integrations/supabase/client.server");
  const db = adminDb();

  // The attachment is usually linked via `messages.media_url`, but older rows
  // (and any send that only embedded the url inside `body`) leave that column
  // null. Match the url in `body` too, otherwise the reader falls through to
  // the folder-owner fallback below — which authorizes only the uploader, so
  // the other participant could never open a DM image/video/voice note.
  const url = mediaUrlFor(path);
  const { data: message } = await db
    .from("messages")
    .select("conversation_id, conversations!inner(user_a, user_b)")
    .or(`media_url.eq.${url},body.like.*${url}*`)
    .limit(1)
    .maybeSingle();
  if (!message) {
    // Legacy attachments uploaded before conversation linkage: fall back to
    // "the caller owns the folder segment". New uploads namespace the segment
    // by profileId; pre-M3 uploads used the auth uid, so both are honoured
    // during the grace period (plan §4.7).
    const segments = path.split("/");
    return segments[1] === profileId || segments[1] === authUserId;
  }

  const convo = (message as any).conversations;
  return convo?.user_a === profileId || convo?.user_b === profileId;
}
