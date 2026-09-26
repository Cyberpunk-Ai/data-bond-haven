import { useState } from "react";
import { Users, UserPlus, Shield, Trash2, Lock, Crown, Check, Mail, Building, Pencil } from "lucide-react";
import { useWorkspace, type Workspace, type WorkspaceRole } from "@/lib/workspace-state";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { Avatar } from "@/components/social/Avatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

export function TeamWorkspaceManager() {
  const { isPro } = usePlan();
  const {
    workspaces,
    activeWorkspace,
    setActiveWsId,
    inviteMember,
    removeMember,
    updateMemberRole,
    canManage,
    updateWorkspaceProfile,
  } = useWorkspace();

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("Editor");
  const [inviting, setInviting] = useState(false);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail || !inviteEmail.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }
    if (!activeWorkspace) return;

    if (activeWorkspace.members.length >= activeWorkspace.seatsTotal) {
      toast.error(`Workspace seat limit reached (${activeWorkspace.seatsTotal} seats max)`);
      return;
    }

    if (activeWorkspace.members.some((m) => m.email.toLowerCase() === inviteEmail.toLowerCase())) {
      toast.error("That person is already on this workspace.");
      return;
    }

    setInviting(true);
    try {
      await inviteMember(inviteEmail, inviteRole);
      toast.success(`Invitation sent to ${inviteEmail} as ${inviteRole}!`);
      setInviteEmail("");
      setIsInviteModalOpen(false);
    } catch (err) {
      toast.error(friendlyError(err, "Could not send that invitation."));
    } finally {
      setInviting(false);
    }
  };

  if (!isPro) return <WorkspacePreview />;

  if (!activeWorkspace) {
    return (
      <div className="rounded-2xl border border-border bg-card p-10 text-center">
        <Building className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h3 className="text-base font-extrabold">Setting up your workspace</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          One moment — we&apos;re preparing your team space.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black">Team Workspaces</h2>
            <span className="flex items-center gap-1 text-[0.65rem] font-extrabold uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Crown className="h-3 w-3" /> Pro Feature
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Collaborate on shared brand accounts, assign editorial roles, and host team spaces.
          </p>
        </div>

        {isPro ? (
          <button
            onClick={() => setIsInviteModalOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span>Invite Team Member</span>
          </button>
        ) : (
          <button
            onClick={() => openUpgradeModal("Team Workspaces & Roles")}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
          >
            <Crown className="h-3.5 w-3.5" />
            <span>Upgrade to Pro ($29/mo)</span>
          </button>
        )}
      </div>

      {!isPro && (
        <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-black">Team Workspaces Require Pro Plan</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Invite up to 10 team members, assign Editor/Analyst/Admin permissions, and manage
              shared social accounts.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("Team Workspaces & Roles")}
            className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Unlock Pro ($29/mo)
          </button>
        </div>
      )}

      {/* Workspace Selector & Seat Stats */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-2xl border border-amber-500/20">
              {activeWorkspace.logoEmoji}
            </div>
            <div>
              <h3 className="text-base font-extrabold">{activeWorkspace.name}</h3>
              <p className="text-xs text-muted-foreground">
                slug: @{activeWorkspace.slug} · Created {activeWorkspace.createdAt}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-muted-foreground">Seats:</span>
            <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-extrabold text-amber-600 dark:text-amber-400">
              {activeWorkspace.members.length} / {activeWorkspace.seatsTotal} Active
            </span>
          </div>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500"
            style={{
              width: `${(activeWorkspace.members.length / activeWorkspace.seatsTotal) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Workspace profile editor — writes name/bio/emoji to the shared brand
          account. Only Owner/Admin can open it; the update itself is re-checked
          server-side by the "workspaces owner update" RLS policy. */}
      {canManage && (
        <WorkspaceProfileEditor
          workspace={activeWorkspace}
          onSave={updateWorkspaceProfile}
          onSwitchTo={(id) => setActiveWsId(id)}
          allWorkspaces={workspaces}
        />
      )}

      {/* Team Roster */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-500" />
            <span>Workspace Members</span>
          </h3>
          <span className="text-xs text-muted-foreground font-semibold">
            {activeWorkspace.members.length} Members
          </span>
        </div>

        <div className="divide-y divide-border/60 max-h-[280px] overflow-y-auto custom-scrollbar pr-1">
          {activeWorkspace.members.map((member) => (
            <div
              key={member.id}
              className="py-3.5 flex items-center justify-between gap-3 flex-wrap"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar
                  name={member.name}
                  src={member.avatar_url}
                  className="h-10 w-10 text-xs shrink-0"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm truncate">{member.name}</span>
                    {member.status === "invited" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-bold text-muted-foreground">
                        Pending Invite
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {member.role === "Owner" ? (
                  <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-extrabold text-amber-600 dark:text-amber-400">
                    👑 Owner
                  </span>
                ) : (
                  <select
                    value={member.role}
                    disabled={!isPro}
                    onChange={(e) => updateMemberRole(member.id, e.target.value as WorkspaceRole)}
                    className="rounded-xl border border-border bg-muted/40 px-2.5 py-1 text-xs font-semibold outline-none focus:border-amber-500"
                  >
                    <option value="Admin">Admin</option>
                    <option value="Editor">Editor</option>
                    <option value="Viewer">Viewer</option>
                  </select>
                )}

                {member.role !== "Owner" && isPro && (
                  <button
                    onClick={() => {
                      removeMember(member.id);
                      toast.success(`Removed ${member.name} from workspace`);
                    }}
                    className="rounded-full p-2 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pro Tier Lock Barrier */}
      {!isPro && (
        <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-black">Team Workspaces Require Pro</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Add up to 10 team seats, manage collaborative multi-author spaces, and assign
              fine-grained roles.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("Team Workspaces")}
            className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Upgrade to Pro ($29/mo)
          </button>
        </div>
      )}

      {/* Invite Member Modal */}
      {isInviteModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200"
          onClick={() => setIsInviteModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black">Invite Workspace Member</h3>
              <button
                onClick={() => setIsInviteModalOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSendInvite} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                  <input
                    type="email"
                    required
                    placeholder="colleague@company.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="w-full rounded-2xl bg-muted/40 border border-border pl-10 pr-4 py-2.5 text-xs font-semibold outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Assign Role
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["Admin", "Editor", "Viewer"] as WorkspaceRole[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setInviteRole(r)}
                      className={cn(
                        "rounded-xl border p-2.5 text-left text-xs font-bold transition-all cursor-pointer",
                        inviteRole === r
                          ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <div>{r}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="flex-1 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {inviting ? "Sending…" : "Send Invitation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline editor for a team's shared brand profile (display name, bio, logo).
 * Rendered only for Owner/Admin; every save is routed through the RLS-guarded
 * `workspaces` UPDATE policy so a granted-but-not-manager member can never
 * mutate it even by hitting the API directly.
 */
function WorkspaceProfileEditor({
  workspace,
  onSave,
}: {
  workspace: Workspace;
  onSave: (patch: { name?: string; bio?: string; logoEmoji?: string }) => Promise<void>;
  onSwitchTo?: (id: string) => void;
  allWorkspaces?: Workspace[];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [bio, setBio] = useState(workspace.bio);
  const [logoEmoji, setLogoEmoji] = useState(workspace.logoEmoji);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName(workspace.name);
    setBio(workspace.bio);
    setLogoEmoji(workspace.logoEmoji);
    setEditing(false);
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error("Workspace needs a name.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), bio: bio.trim(), logoEmoji: logoEmoji.trim() || "✨" });
      toast.success("Workspace profile updated.");
      setEditing(false);
    } catch (err) {
      toast.error(friendlyError(err, "Could not save the workspace profile."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold flex items-center gap-2">
          <Building className="h-4 w-4 text-amber-500" />
          <span>Workspace Profile</span>
        </h3>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit profile
          </button>
        )}
      </div>

      {!editing ? (
        <div className="space-y-1">
          {bio ? (
            <p className="text-sm text-muted-foreground leading-relaxed">{bio}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No description yet — add one so teammates know what this account posts.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[4rem_1fr]">
            <div>
              <label className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
                Logo
              </label>
              <input
                value={logoEmoji}
                onChange={(e) => setLogoEmoji(e.target.value)}
                maxLength={2}
                className="mt-1 h-10 w-full rounded-xl border border-border bg-muted/40 text-center text-xl outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
                Display name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm font-semibold outline-none focus:border-amber-500"
              />
            </div>
          </div>
          <div>
            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
              Bio
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={2}
              maxLength={280}
              placeholder="What does this team account post about?"
              className="mt-1 w-full resize-none rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm outline-none focus:border-amber-500"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={reset}
              className="rounded-full px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-foreground/5 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer disabled:opacity-60"
            >
              {saving ? "Saving…" : <><Check className="h-3.5 w-3.5" /> Save profile</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Locked preview shown to everyone below the Pro plan. It intentionally renders
 * no real workspace data (no roster, seats, or member emails) — just a sample
 * showcase and an upgrade path — so the Settings tab behaves like the gated
 * Developer API preview rather than exposing the live manager to non-Pro users.
 */
function WorkspacePreview() {
  const roles = ["Admin", "Editor", "Viewer"];
  const features = [
    {
      icon: UserPlus,
      title: "Invite up to 10 teammates",
      desc: "Bring writers, designers, and analysts into one shared brand account.",
    },
    {
      icon: Shield,
      title: "Granular editorial roles",
      desc: "Control who can publish, review analytics, or manage billing and seats.",
    },
    {
      icon: Users,
      title: "Multi-author team spaces",
      desc: "Host live audio spaces together and co-manage your growing community.",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black">Team Workspaces</h2>
            <span className="flex items-center gap-1 text-[0.65rem] font-extrabold uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Crown className="h-3 w-3" /> Pro Feature
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Collaborate on shared brand accounts, assign editorial roles, and host team spaces.
          </p>
        </div>
        <button
          onClick={() => openUpgradeModal("Team Workspaces & Roles")}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
        >
          <Crown className="h-3.5 w-3.5" />
          <span>Upgrade to Pro ($29/mo)</span>
        </button>
      </div>

      {/* Locked banner */}
      <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="space-y-1 text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2">
            <Lock className="h-4 w-4 text-amber-500" />
            <h4 className="text-sm font-black">Team Workspaces Require Pro</h4>
          </div>
          <p className="text-xs text-muted-foreground">
            This is a preview. Upgrade to invite your team and unlock roles, seats, and shared
            publishing.
          </p>
        </div>
        <button
          onClick={() => openUpgradeModal("Team Workspaces & Roles")}
          className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
        >
          Unlock Pro ($29/mo)
        </button>
      </div>

      {/* Feature highlights */}
      <div className="grid gap-3 sm:grid-cols-3">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-3xl border border-border/80 bg-card p-5 space-y-2 shadow-soft"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <f.icon className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-extrabold">{f.title}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Blurred sample roster — clearly a preview, no real data */}
      <div className="relative rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft overflow-hidden">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-500" />
            <span>Workspace Members</span>
          </h3>
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-extrabold text-amber-600 dark:text-amber-400">
            0 / 10 seats
          </span>
        </div>

        <div className="space-y-1 blur-[3px] select-none pointer-events-none" aria-hidden="true">
          {[
            { n: "You (Owner)", r: "Owner" },
            { n: "Alex Rivera", r: "Editor" },
            { n: "Priya Nair", r: "Analyst" },
          ].map((m) => (
            <div
              key={m.n}
              className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40 last:border-0"
            >
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-muted" />
                <div>
                  <p className="text-sm font-bold">{m.n}</p>
                  <p className="text-xs text-muted-foreground">team@company.com</p>
                </div>
              </div>
              <div className="flex gap-1.5">
                {roles.map((r) => (
                  <span
                    key={r}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[0.6rem] font-bold",
                      r === m.r
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-card via-card/50 to-transparent">
          <button
            onClick={() => openUpgradeModal("Team Workspaces & Roles")}
            className="flex items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
          >
            <Lock className="h-3.5 w-3.5" />
            <span>Upgrade to manage your team</span>
          </button>
        </div>
      </div>
    </div>
  );
}
