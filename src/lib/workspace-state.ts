import { useEffect, useState } from "react";

import { currentUser } from "@/lib/profile-service";
import { supabase } from "@/integrations/supabase/client";
import { signedInProfileId } from "@/lib/remote-store";

const db = supabase as any;

export type WorkspaceRole = "Owner" | "Admin" | "Editor" | "Analyst" | "Contributor";

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
  role: WorkspaceRole;
  status: "active" | "invited";
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoEmoji: string;
  createdAt: string;
  seatsTotal: number;
  members: WorkspaceMember[];
}

const STORAGE_KEY = "spaces:workspaces";

// Workspaces always come from the database; nothing is kept in the browser so
// switching accounts never shows another account's team.
let workspaces: Workspace[] = [];
let activeWsId = "";
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function commit(next: Workspace[]) {
  workspaces = next;
  if (!next.some((ws) => ws.id === activeWsId)) activeWsId = next[0]?.id ?? "";
  listeners.forEach((fn) => fn());
}

function mutateActive(fn: (ws: Workspace) => Workspace) {
  commit(workspaces.map((ws) => (ws.id === activeWsId ? fn(ws) : ws)));
}

async function hydrate(force = false) {
  const userId = signedInProfileId();
  if (!userId) {
    loadedFor = null;
    if (workspaces.length) commit([]);
    return;
  }
  if (loadedFor === userId && !force) return;
  loadedFor = userId;

  const { data: owned } = await db.from("workspaces").select("*").order("created_at");
  let rows = (owned ?? []) as Record<string, any>[];

  // Everyone gets their own studio the first time they open the team screen.
  if (rows.length === 0) {
    const { data: created } = await db
      .from("workspaces")
      .insert({
        owner_id: userId,
        name: `${currentUser.display_name || currentUser.username || "My"} Studio`,
      })
      .select("*")
      .maybeSingle();
    if (!created) return;
    rows = [created as Record<string, any>];
    await db.from("workspace_members").insert({
      workspace_id: created.id,
      user_id: userId,
      email: currentUser.email ?? "",
      name: currentUser.display_name || currentUser.username || "You",
      role: "Owner",
      status: "active",
    });
  }
  const { data: memberRows } = await db
    .from("workspace_members")
    .select("*")
    .in(
      "workspace_id",
      rows.map((r) => r.id),
    );
  const members = (memberRows ?? []) as Record<string, any>[];
  const next: Workspace[] = rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.name).toLowerCase().replace(/\s+/g, "-"),
    logoEmoji: String(row.logo_emoji ?? "🚀"),
    createdAt: new Date(row.created_at).toLocaleDateString(),
    seatsTotal: Number(row.seats_total ?? 3),
    members: members
      .filter((m) => m.workspace_id === row.id)
      .map((m) => ({
        id: String(m.id),
        name: String(m.name || String(m.email).split("@")[0]),
        email: String(m.email),
        avatar_url: null,
        role: (m.role ?? "Contributor") as WorkspaceRole,
        status: (m.status === "active" ? "active" : "invited") as WorkspaceMember["status"],
      })),
  }));
  commit(next);
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

  const activeWorkspace = workspaces.find((w) => w.id === activeWsId) ?? workspaces[0];

  return {
    workspaces,
    activeWorkspace,
    activeWsId,
    setActiveWsId: (id: string) => {
      activeWsId = id;
      listeners.forEach((fn) => fn());
    },
    async inviteMember(email: string, role: WorkspaceRole) {
      if (!activeWsId) throw new Error("Create a workspace first.");
      const { error } = await db.from("workspace_members").insert({
        workspace_id: activeWsId,
        email,
        name: email.split("@")[0] || "Teammate",
        role,
        status: "invited",
      });
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
      listeners.forEach((fn) => fn());
    },
  };
}
