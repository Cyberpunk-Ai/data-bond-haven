/**
 * Public, read-only lookup that powers the team-workspace profile page.
 *
 * `getWorkspaceProfile` returns only the *public* identity of a workspace —
 * name, logo, bio, join date and post count. It deliberately omits the member
 * roster and owner, so clicking a team post surfaces the team rather than the
 * individual who published it. The data comes from the `get_workspace_profile`
 * SECURITY DEFINER function (see migration 20260926000072), which reads the
 * fixed public columns only. Mirrors `getSharedProfile` in shape: it runs on
 * the server with the anon client so link previews and the SSR loader work,
 * and the RPC's grant makes the roster unreachable regardless of caller.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

import { workspaceSlug } from "@/lib/workspace-state";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Backend is not configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { apikey: key } },
  });
}

/**
 * Everything the workspace profile page shows about a team. No emails, no
 * member identities, no owner — just the brand identity, how many posts it
 * has, and a plain head-count of active members (public the same way a
 * follower count is on a personal profile).
 */
export interface WorkspaceProfile {
  id: string;
  name: string;
  slug: string;
  logoEmoji: string;
  avatarUrl: string | null;
  bio: string;
  createdAt: string;
  postCount: number;
  memberCount: number;
}

export const getWorkspaceProfile = createServerFn({ method: "GET" })
  .inputValidator((input: { id?: string }) => {
    const id = String(input?.id ?? "");
    if (!UUID_RE.test(id)) throw new Error("Unknown workspace.");
    return { id };
  })
  .handler(async ({ data }): Promise<WorkspaceProfile | null> => {
    const supabase = publicClient() as any;
    const { data: row, error } = await supabase.rpc("get_workspace_profile", {
      _workspace_id: data.id,
    });
    if (error) {
      console.error("get_workspace_profile failed:", error);
      throw new Error("We couldn't load that team right now. Please try again.");
    }
    const found = (Array.isArray(row) ? row[0] : row) as Record<string, any> | undefined;
    if (!found) return null;
    return {
      id: String(found.id),
      name: String(found.name ?? "Workspace"),
      slug: workspaceSlug(String(found.name ?? "")),
      logoEmoji: String(found.logo_emoji ?? "✨"),
      avatarUrl: found.avatar_url ?? null,
      bio: String(found.bio ?? ""),
      createdAt: String(found.created_at ?? ""),
      postCount: Number(found.post_count ?? 0),
      memberCount: Number(found.member_count ?? 0),
    };
  });
