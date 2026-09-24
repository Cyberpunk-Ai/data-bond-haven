import { useEffect, useState } from "react";

import { currentUser } from "@/lib/profile-service";
import { supabase } from "@/integrations/supabase/client";
import { signedInProfileId } from "@/lib/remote-store";

const db = supabase as any;

export type WorkspaceRole = "Owner" | "Admin" | "Editor" | "Viewer";

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
  role: WorkspaceRole;
  status: "active" | "invited" | "declined";
  userId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoEmoji: string;
  avatarUrl: string | null;
  bio: string;
  createdAt: string;
  seatsTotal: number;
  members: WorkspaceMember[];
  myRole: WorkspaceRole | null;
}

export interface PendingInvite {
  memberId: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

const ACTIVE_KEY = "spaces:activeWorkspace";
const PERSONAL_ID = "personal";

// Workspaces always come from the database; nothing is kept in the browser except
// which one is currently active, so switching accounts never shows another
// account's team but the choice of workspace survives a refresh.
let workspaces: Workspace[] = [];
let pendingInvites: PendingInvite[] = [];
let activeWsId = PERSONAL_ID;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function readStoredActiveId(): string {
  if (typeof window === "undefined") return PERSONAL_ID;
  try {
    return window.localStorage.getItem(ACTIVE_KEY) || PERSONAL_ID;
  } catch {
    return PERSONAL_ID;
  }
}

function persistActiveId(id: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

function commit(next: Workspace[]) {
  workspaces = next;
  const stored = readStoredActiveId();
  if (stored === PERSONAL_ID || next.some((ws) => ws.id === stored)) {
    activeWsId = stored;
  } else {
    activeWsId = PERSONAL_ID;
  }
  listeners.forEach((fn) => fn());
}

async function hydrate(force = false) {
  const userId = signedInProfileId();
  if (!userId) {
    loadedFor = null;
    if (workspaces.length) commit([]);
    pendingInvites = [];
    return;
  }
  if (loadedFor === userId && !force) return;
  loadedFor = userId;

  // Workspaces the caller owns, plus workspaces they're an active member of.
  const [{ data: owned }, { data: memberOf }] = await Promise.all([
    db.from("workspaces").select("*").order("created_at"),
    db.from("workspace_members").select("workspace_id").eq("user_id", userId).eq("status", "active"),
  ]);
  const ids = new Set<string>([...(owned ?? []).map((r: any) => r.id)]);
  const extraIds = (memberOf ?? []).map((r: any) => r.workspace_id).filter((id: string) => !ids.has(id));
  let rows = (owned ?? []) as Record<string, any>[];
  if (extraIds.length) {
    const { data: extra } = await db.from("workspaces").select("*").in("id", extraIds);
    rows = [...rows, ...((extra ?? []) as Record<string, any>[])];
  }

  const { data: memberRows } = rows.length
    ? await db
        .from("workspace_members")
        .select("*")
        .in(
          "workspace_id",
          rows.map((r) => r.id),
        )
    : { data: [] };
  const members = (memberRows ?? []) as Record<string, any>[];
  const next: Workspace[] = rows.map((row) => {
    const rowMembers = members
      .filter((m) => m.workspace_id === row.id)
      .map((m) => ({
        id: String(m.id),
        name: String(m.name || String(m.email).split("@")[0]),
        email: String(m.email),
        avatar_url: null,
        role: (m.role ?? "Viewer") as WorkspaceRole,
        status: (m.status === "active" ? "active" : m.status === "declined" ? "declined" : "invited") as WorkspaceMember["status"],
        userId: m.user_id ?? null,
      }));
    const myRole: WorkspaceRole | null =
      row.owner_id === userId ? "Owner" : (rowMembers.find((m) => m.userId === userId)?.role ?? null);
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.name).toLowerCase().replace(/\s+/g, "-"),
      logoEmoji: String(row.logo_emoji ?? "🚀"),
      avatarUrl: row.avatar_url ?? null,
      bio: String(row.bio ?? ""),
      createdAt: new Date(row.created_at).toLocaleDateString(),
      seatsTotal: Number(row.seats_total ?? 3),
      members: rowMembers.filter((m) => m.status !== "declined"),
      myRole,
    };
  });
  pendingInvites = members
    .filter((m) => m.user_id === userId && m.status === "invited")
    .map((m) => {
      const ws = rows.find((r) => r.id === m.workspace_id);
      return {
        memberId: String(m.id),
        workspaceId: String(m.workspace_id),
        workspaceName: ws ? String(ws.name) : "a team",
        role: (m.role ?? "Viewer") as WorkspaceRole,
      };
    });
  commit(next);
}

function mutateActive(fn: (ws: Workspace) => Workspace) {
  workspaces = workspaces.map((ws) => (ws.id === activeWsId ? fn(ws) : ws));
  listeners.forEach((fn) => fn());
}

export function useWorkspace() {
  const [, force] = useState(0);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    void hydrate();
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  const activeWorkspace =
    activeWsId === PERSONAL_ID ? undefined : workspaces.find((w) => w.id === activeWsId);
  const canManage = activeWorkspace?.myRole === "Owner" || activeWorkspace?.myRole === "Admin";
  const canPost = canManage || activeWorkspace?.myRole === "Editor";

  return {
    workspaces,
    activeWorkspace,
    activeWsId,
    isPersonal: activeWsId === PERSONAL_ID,
    pendingInvites,
    canManage,
    canPost,
    setActiveWsId: (id: string) => {
      activeWsId = id;
      persistActiveId(id);
      listeners.forEach((fn) => fn());
    },
    async inviteMember(handle: string, role: WorkspaceRole) {
      if (!activeWsId || activeWsId === PERSONAL_ID) throw new Error("Choose a workspace first.");
      const isEmail = handle.includes("@") && handle.includes(".");
      const payload: Record<string, unknown> = {
        workspace_id: activeWsId,
        role,
        status: "invited",
        email: isEmail ? handle : "",
        name: isEmail ? handle.split("@")[0] : handle.replace(/^@/, ""),
      };
      if (!isEmail) {
        // Invite by @username: resolve to their email so the row is always identifiable.
        const uname = handle.replace(/^@/, "");
        const { data: profile } = await db
          .from("profiles")
          .select("id,username,display_name")
          .ilike("username", uname)
          .maybeSingle();
        if (!profile) throw new Error("No account found with that username.");
        payload.email = `${profile.username}@users.spaces`;
        payload.name = profile.display_name || profile.username;
        payload.user_id = profile.id;
      }
      const { error } = await db.from("workspace_members").insert(payload);
      if (error) throw new Error(error.message);
      await hydrate(true);
    },
    async removeMember(id: string) {
      mutateActive((ws) => ({ ...ws, members: ws.members.filter((m) => m.id !== id) }));
      const { error } = await db.from("workspace_members").delete().eq("id", id);
      if (error) await hydrate(true);
    },
    async updateMemberRole(id: string, role: WorkspaceRole) {
      mutateActive((ws) => ({
        ...ws,
        members: ws.members.map((m) => (m.id === id ? { ...m, role } : m)),
      }));
      const { error } = await db.from("workspace_members").update({ role }).eq("id", id);
      if (error) await hydrate(true);
    },
    async createWorkspace(name: string, logoEmoji = "✨") {
      const userId = signedInProfileId();
      if (!userId) throw new Error("Sign in to create a workspace.");
      const { data, error } = await db
        .from("workspaces")
        .insert({ name, owner_id: userId, logo_emoji: logoEmoji })
        .select("id")
        .maybeSingle();
      if (error || !data?.id) throw new Error(error?.message ?? "Could not create that workspace.");
      await db.from("workspace_members").insert({
        workspace_id: data.id,
        user_id: userId,
        email: currentUser.email ?? "",
        name: currentUser.display_name || currentUser.username || "You",
        role: "Owner",
        status: "active",
      });
      await hydrate(true);
      activeWsId = String(data.id);
      persistActiveId(activeWsId);
      listeners.forEach((fn) => fn());
    },
    async updateWorkspaceProfile(patch: { name?: string; bio?: string; avatarUrl?: string | null; logoEmoji?: string }) {
      if (!activeWsId || activeWsId === PERSONAL_ID) throw new Error("Choose a workspace first.");
      const row: Record<string, unknown> = {};
      if (patch.name !== undefined) row["name"] = patch.name;
      if (patch.bio !== undefined) row["bio"] = patch.bio;
      if (patch.avatarUrl !== undefined) row["avatar_url"] = patch.avatarUrl;
      if (patch.logoEmoji !== undefined) row["logo_emoji"] = patch.logoEmoji;
      const { error } = await db.from("workspaces").update(row).eq("id", activeWsId);
      if (error) throw new Error(error.message);
      await hydrate(true);
    },
    async respondToInvite(memberId: string, accept: boolean) {
      const { error } = await db.rpc("respond_workspace_invite", { _member_id: memberId, _accept: accept });
      if (error) throw new Error(error.message);
      await hydrate(true);
    },
    async postAsWorkspace(content: string) {
      if (!activeWsId || activeWsId === PERSONAL_ID) throw new Error("Choose a workspace first.");
      const userId = signedInProfileId();
      if (!userId) throw new Error("Sign in to post.");
      const { error } = await db.from("posts").insert({
        user_id: userId,
        workspace_id: activeWsId,
        content,
      });
      if (error) throw new Error(error.message);
    },
  };
}
