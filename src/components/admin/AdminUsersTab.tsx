import { useState, useEffect } from "react";
import {
  Search,
  Filter,
  Shield,
  ShieldAlert,
  Award,
  AlertTriangle,
  Ban,
  CheckCircle2,
  MoreHorizontal,
  UserCheck,
  UserX,
  Mail,
  Calendar,
  AlertCircle,
  RefreshCw,
  Plus,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { getAdminUsers, updateUserAdmin } from "@/lib/api-client";
import { listAccessLevels, setAccessLevel } from "@/lib/admin.functions";
import { useRealtime } from "@/lib/realtime";
import type { Profile, UserRole, UserStatus } from "@/lib/types";
import { ROLE_DEFINITIONS } from "./AdminHeader";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AdminUsersTabProps {
  activeRole: UserRole;
  currentUserId: string;
}

export function AdminUsersTab({ activeRole, currentUserId }: AdminUsersTabProps) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("all");
  const [selectedVerifiedFilter, setSelectedVerifiedFilter] = useState<string>("all");
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const res = await getAdminUsers({
        query: searchQuery || undefined,
        role: selectedRoleFilter !== "all" ? selectedRoleFilter : undefined,
        status: selectedStatusFilter !== "all" ? selectedStatusFilter : undefined,
        verified: selectedVerifiedFilter === "all" ? undefined : selectedVerifiedFilter === "true",
      });
      let roleMap: Record<string, string> = {};
      try {
        roleMap = (await listAccessLevels()) as Record<string, string>;
      } catch {
        roleMap = {};
      }
      setUsers(
        res.map((u: Profile) => ({ ...u, role: (roleMap[u.id] as UserRole) ?? u.role ?? "user" })),
      );
    } catch (err) {
      console.error("Failed to load admin users", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [searchQuery, selectedRoleFilter, selectedStatusFilter, selectedVerifiedFilter]);

  useRealtime({
    "user:updated": (updatedUser: Profile) => {
      setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? { ...u, ...updatedUser } : u)));
    },
  });

  const handleUpdateRole = async (userId: string, newRole: UserRole) => {
    try {
      const res = await setAccessLevel({ data: { profileId: userId, role: newRole } });
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      setEditingUser(null);
      showNotice(`Updated access for @${res.username} to ${newRole}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to update role");
    }
  };

  const handleUpdateStatus = async (userId: string, newStatus: UserStatus) => {
    try {
      const updated = await updateUserAdmin(userId, { status: newStatus }, currentUserId);
      setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
      showNotice(`User @${updated.username} marked as ${newStatus}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to update status");
    }
  };

  const handleToggleVerified = async (user: Profile) => {
    try {
      const updated = await updateUserAdmin(user.id, { verified: !user.verified }, currentUserId);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
      showNotice(
        updated.verified
          ? `Granted verified creator badge to @${user.username}`
          : `Revoked verification from @${user.username}`,
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to update verified badge");
    }
  };

  const handleWarningChange = async (user: Profile, delta: number) => {
    const newCount = Math.max(0, (user.warning_count || 0) + delta);
    try {
      const updated = await updateUserAdmin(user.id, { warning_count: newCount }, currentUserId);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
      showNotice(`Warning count for @${user.username} is now ${newCount}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to change warning count");
    }
  };

  /** Grants or removes a paid plan for a member (administrators only). */
  const handlePlanChange = async (user: Profile, plan: string) => {
    if (plan === (user.plan || "free")) return;
    try {
      const updated = await updateUserAdmin(user.id, { plan }, currentUserId);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
      showNotice(`@${user.username} is now on the ${plan} plan`);
    } catch (err: any) {
      toast.error(err.message || "Could not change that plan. Please try again.");
    }
  };

  const showNotice = (msg: string) => {
    setActionSuccessMessage(msg);
    toast.success(msg);
    setTimeout(() => setActionSuccessMessage(null), 3500);
  };

  const canManageRoles = ["superadmin", "admin"].includes(activeRole);
  const canBanUsers = ["superadmin", "admin", "moderator"].includes(activeRole);
  const canVerifyCreators = ["superadmin", "admin", "community"].includes(activeRole);

  return (
    <div className="space-y-6">
      {/* Toast notice */}
      {actionSuccessMessage && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-800 dark:text-emerald-200 shadow-soft animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>{actionSuccessMessage}</span>
        </div>
      )}

      {/* Control Bar: Filters & Search */}
      <div className="glass-panel rounded-3xl border border-border/80 p-4 shadow-soft">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by name, handle (@username), or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-2xl border border-border bg-background/80 py-2.5 pl-10 pr-4 text-xs font-medium text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Role Filter */}
            <select
              value={selectedRoleFilter}
              onChange={(e) => setSelectedRoleFilter(e.target.value)}
              className="rounded-2xl border border-border bg-background/80 px-3 py-2 text-xs font-semibold text-foreground focus:outline-none"
            >
              <option value="all">All Roles</option>
              <option value="superadmin">Super Admin</option>
              <option value="admin">Platform Admin</option>
              <option value="moderator">Moderator</option>
              <option value="analyst">Analyst</option>
              <option value="community">Community Lead</option>
              <option value="user">Standard User</option>
            </select>

            {/* Status Filter */}
            <select
              value={selectedStatusFilter}
              onChange={(e) => setSelectedStatusFilter(e.target.value)}
              className="rounded-2xl border border-border bg-background/80 px-3 py-2 text-xs font-semibold text-foreground focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="flagged">Flagged</option>
              <option value="suspended">Suspended</option>
              <option value="banned">Banned</option>
            </select>

            {/* Verified Filter */}
            <select
              value={selectedVerifiedFilter}
              onChange={(e) => setSelectedVerifiedFilter(e.target.value)}
              className="rounded-2xl border border-border bg-background/80 px-3 py-2 text-xs font-semibold text-foreground focus:outline-none"
            >
              <option value="all">All Badges</option>
              <option value="true">Verified Creators</option>
              <option value="false">Unverified</option>
            </select>

            <button
              onClick={fetchUsers}
              className="flex items-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-brand")} />
              <span>Filter</span>
            </button>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="glass-panel overflow-hidden rounded-3xl border border-border/80 shadow-soft">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border/60 bg-foreground/5 text-muted-foreground uppercase tracking-wider font-bold text-[0.68rem]">
              <tr>
                <th className="px-5 py-3.5">User Identity</th>
                <th className="px-4 py-3.5">Role (RBAC)</th>
                <th className="px-4 py-3.5">Status</th>
                <th className="px-4 py-3.5">Warnings</th>
                <th className="px-4 py-3.5">Followers</th>
                <th className="px-4 py-3.5">Creator Badge</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground">
                    <RefreshCw className="mx-auto h-5 w-5 animate-spin text-brand mb-2" />
                    Loading user directory...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground">
                    No users found matching current filters.
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const roleMeta = ROLE_DEFINITIONS[user.role || "user"] || ROLE_DEFINITIONS.user;
                  const RoleIcon = roleMeta.icon;
                  const isCurrentUser = user.id === currentUserId;

                  const statusConfig = {
                    active:
                      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
                    flagged:
                      "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
                    suspended:
                      "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
                    banned: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
                  }[user.status || "active"];

                  return (
                    <tr key={user.id} className="transition-colors hover:bg-foreground/5">
                      {/* Identity */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <Avatar
                            name={user.display_name}
                            src={user.avatar_url}
                            className="h-9 w-9 text-xs"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-bold text-foreground">
                              <span className="truncate">{user.display_name}</span>
                              {user.verified && (
                                <Award className="h-3.5 w-3.5 text-brand shrink-0" />
                              )}
                              {isCurrentUser && (
                                <span className="rounded-md bg-brand/15 px-1.5 py-0.2 text-[0.6rem] text-brand font-bold">
                                  You
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-[0.7rem] text-muted-foreground">
                              <span>@{user.username}</span>
                              {user.email && <span>· {user.email}</span>}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Role Badge */}
                      <td className="px-4 py-3.5">
                        <button
                          disabled={
                            !canManageRoles ||
                            (user.role === "superadmin" && activeRole !== "superadmin")
                          }
                          onClick={() => setEditingUser(user)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[0.72rem] font-bold transition-all shadow-2xs",
                            roleMeta.badgeBg,
                            canManageRoles && "hover:brightness-95 cursor-pointer",
                          )}
                          title={canManageRoles ? "Click to change role" : undefined}
                        >
                          <RoleIcon className="h-3 w-3" />
                          <span>{roleMeta.label}</span>
                          {canManageRoles && <span className="text-[0.6rem] opacity-70">✎</span>}
                        </button>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.68rem] font-bold capitalize",
                            statusConfig,
                          )}
                        >
                          {user.status || "active"}
                        </span>
                      </td>

                      {/* Warnings */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-[0.7rem] font-bold",
                              (user.warning_count || 0) > 0
                                ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                                : "text-muted-foreground",
                            )}
                          >
                            {user.warning_count || 0}
                          </span>
                          {canBanUsers && (
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => handleWarningChange(user, 1)}
                                className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-amber-600"
                                title="Issue warning"
                              >
                                +
                              </button>
                              {(user.warning_count || 0) > 0 && (
                                <button
                                  onClick={() => handleWarningChange(user, -1)}
                                  className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                                  title="Reduce warning"
                                >
                                  -
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Followers */}
                      <td className="px-4 py-3.5 font-semibold text-foreground">
                        {user.followers.toLocaleString()}
                      </td>

                      {/* Creator Verification */}
                      <td className="px-4 py-3.5">
                        <button
                          disabled={!canVerifyCreators}
                          onClick={() => handleToggleVerified(user)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-[0.7rem] font-bold transition-colors",
                            user.verified
                              ? "border-brand/30 bg-brand/10 text-brand"
                              : "border-border bg-foreground/5 text-muted-foreground hover:text-foreground",
                            !canVerifyCreators && "opacity-60 cursor-not-allowed",
                          )}
                        >
                          <Award className="h-3 w-3" />
                          <span>{user.verified ? "Verified" : "Unverified"}</span>
                        </button>
                      </td>

                      {/* Moderation Actions */}
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {canManageRoles && (
                            <select
                              value={user.plan || "free"}
                              onChange={(e) => handlePlanChange(user, e.target.value)}
                              aria-label={`Plan for @${user.username}`}
                              title="Change this member's plan"
                              className="rounded-xl border border-border bg-card px-2 py-1 text-[0.7rem] font-bold text-foreground"
                            >
                              <option value="free">Free</option>
                              <option value="plus">Plus</option>
                              <option value="pro">Pro</option>
                            </select>
                          )}
                          {canBanUsers && user.status !== "banned" && (
                            <button
                              onClick={() => handleUpdateStatus(user.id, "banned")}
                              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[0.7rem] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20"
                              title="Ban user from platform"
                            >
                              Ban
                            </button>
                          )}
                          {canBanUsers && user.status === "banned" && (
                            <button
                              onClick={() => handleUpdateStatus(user.id, "active")}
                              className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.7rem] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                              title="Reactivate account"
                            >
                              Unban
                            </button>
                          )}
                          {canBanUsers &&
                            user.status !== "suspended" &&
                            user.status !== "banned" && (
                              <button
                                onClick={() => handleUpdateStatus(user.id, "suspended")}
                                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[0.7rem] font-bold text-amber-800 dark:text-amber-300 hover:bg-amber-500/20"
                                title="Temporary suspension"
                              >
                                Suspend
                              </button>
                            )}
                          {user.status === "suspended" && (
                            <button
                              onClick={() => handleUpdateStatus(user.id, "active")}
                              className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.7rem] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role Assignment Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-foreground/30 backdrop-blur-sm"
            onClick={() => setEditingUser(null)}
          />
          <div className="relative w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-lift">
            <h3 className="text-base font-extrabold text-foreground">
              Modify RBAC Role for @{editingUser.username}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Select the administrative permissions boundary to apply to {editingUser.display_name}.
            </p>

            <div className="space-y-2 mt-4">
              {(Object.keys(ROLE_DEFINITIONS) as UserRole[]).map((roleKey) => {
                const meta = ROLE_DEFINITIONS[roleKey];
                const Icon = meta.icon;
                const isCurrent = (editingUser.role || "user") === roleKey;
                return (
                  <button
                    key={roleKey}
                    onClick={() => handleUpdateRole(editingUser.id, roleKey)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-all",
                      isCurrent
                        ? "border-brand bg-brand/10 shadow-xs"
                        : "border-border hover:bg-foreground/5",
                    )}
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.color)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-foreground">{meta.label}</span>
                        {isCurrent && (
                          <span className="rounded-full bg-brand px-2 py-0.2 text-[0.6rem] font-extrabold text-white">
                            Current
                          </span>
                        )}
                      </div>
                      <p className="text-[0.7rem] text-muted-foreground mt-0.5 leading-relaxed">
                        {meta.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditingUser(null)}
                className="rounded-2xl border border-border px-4 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
