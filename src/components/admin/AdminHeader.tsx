import { useState } from "react";
import {
  Shield,
  ShieldAlert,
  Sparkles,
  UserCheck,
  Eye,
  Cpu,
  Database,
  Activity,
  RefreshCw,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import type { Profile, UserRole, AdminOverviewData } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AdminHeaderProps {
  currentProfile: Profile;
  activeRole: UserRole;
  onRoleChange: (role: UserRole) => void;
  systemHealth?: AdminOverviewData["stats"]["system_health"];
  onRefresh: () => void;
  isRefreshing: boolean;
}

export const ROLE_DEFINITIONS: Record<
  UserRole,
  { label: string; description: string; color: string; badgeBg: string; icon: typeof Shield }
> = {
  superadmin: {
    label: "Super Admin",
    description:
      "Full master control: platform configuration, feature flags, user roles, system maintenance, & audit trail.",
    color: "text-rose-600 dark:text-rose-400",
    badgeBg: "bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-300",
    icon: ShieldAlert,
  },
  admin: {
    label: "Platform Admin",
    description:
      "User suspensions, creator verification, announcement broadcast, spaces management, & content deletion.",
    color: "text-violet-600 dark:text-violet-400",
    badgeBg: "bg-violet-500/15 border-violet-500/30 text-violet-700 dark:text-violet-300",
    icon: Shield,
  },
  moderator: {
    label: "Content Moderator",
    description:
      "Triage reports queue, enforce community guidelines, issue user warnings, and remove violative posts.",
    color: "text-amber-600 dark:text-amber-400",
    badgeBg: "bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-300",
    icon: Shield,
  },
  analyst: {
    label: "Platform Analyst",
    description:
      "Read-only access to engagement telemetry, impression reach curves, creator velocity, & exportable stats.",
    color: "text-blue-600 dark:text-blue-400",
    badgeBg: "bg-blue-500/15 border-blue-500/30 text-blue-700 dark:text-blue-300",
    icon: Activity,
  },
  community: {
    label: "Community Lead",
    description:
      "Promote live audio spaces, verify creators, curate trending topics, and manage platform announcements.",
    color: "text-emerald-600 dark:text-emerald-400",
    badgeBg: "bg-emerald-500/15 border-emerald-500/30 text-emerald-800 dark:text-emerald-300",
    icon: UserCheck,
  },
  user: {
    label: "Standard Member",
    description:
      "Standard feed, social posting, and spaces listener (no administrative privileges).",
    color: "text-muted-foreground",
    badgeBg: "bg-muted/40 border-border text-muted-foreground",
    icon: Eye,
  },
};

export function AdminHeader({
  currentProfile,
  activeRole,
  onRoleChange,
  systemHealth,
  onRefresh,
  isRefreshing,
}: AdminHeaderProps) {
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const activeRoleMeta = ROLE_DEFINITIONS[activeRole] || ROLE_DEFINITIONS.superadmin;
  const ActiveIcon = activeRoleMeta.icon;

  return (
    <div className="glass-panel mb-6 overflow-hidden rounded-3xl border border-border/80 p-5 shadow-soft">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        {/* Title & Branding */}
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-pink text-white shadow-soft">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-black tracking-tight text-foreground">
                Spaces Admin Console
              </h1>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live Node
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Unified governance, real-time telemetry, RBAC permissions, and moderation
              infrastructure
            </p>
          </div>
        </div>

        {/* System Health Telemetry & Role Switcher */}
        <div className="flex flex-wrap items-center gap-3">
          {systemHealth && (
            <div className="hidden sm:flex items-center gap-3 rounded-2xl bg-foreground/5 px-3 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-brand" />
                <span>
                  Driver:{" "}
                  <strong className="font-semibold text-foreground capitalize">
                    {systemHealth.db_driver}
                  </strong>
                </span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-violet-500" />
                <span>
                  Heap:{" "}
                  <strong className="font-semibold text-foreground">
                    {systemHealth.memory_mb} MB
                  </strong>
                </span>
              </div>
            </div>
          )}

          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 rounded-2xl border border-border bg-card/60 px-3 py-2 text-xs font-semibold text-foreground shadow-xs transition-colors hover:bg-foreground/5 disabled:opacity-50"
            title="Refresh Platform State"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-brand")} />
            <span>Sync</span>
          </button>

          {/* Interactive Role Switcher for RBAC Simulation */}
          <div className="relative">
            <button
              onClick={() => setRoleDropdownOpen(!roleDropdownOpen)}
              className={cn(
                "flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-xs font-bold transition-all shadow-xs",
                activeRoleMeta.badgeBg,
              )}
            >
              <ActiveIcon className="h-3.5 w-3.5" />
              <span>Role: {activeRoleMeta.label}</span>
              <span className="text-[0.65rem] opacity-70">▼</span>
            </button>

            {roleDropdownOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setRoleDropdownOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-border bg-card p-2 shadow-lift backdrop-blur-xl">
                  <div className="px-3 py-2 border-b border-border/60 mb-1">
                    <p className="text-[0.7rem] font-bold uppercase tracking-wider text-muted-foreground">
                      Simulate Role Access (RBAC)
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Switch access level to test and verify permission barriers
                    </p>
                  </div>
                  <div className="space-y-1">
                    {(Object.keys(ROLE_DEFINITIONS) as UserRole[]).map((roleKey) => {
                      const meta = ROLE_DEFINITIONS[roleKey];
                      const Icon = meta.icon;
                      const isSelected = activeRole === roleKey;
                      return (
                        <button
                          key={roleKey}
                          onClick={() => {
                            onRoleChange(roleKey);
                            setRoleDropdownOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition-colors",
                            isSelected
                              ? "bg-brand/10 text-brand"
                              : "hover:bg-foreground/5 text-foreground",
                          )}
                        >
                          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.color)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold">{meta.label}</span>
                              {isSelected && (
                                <span className="rounded-full bg-brand px-1.5 py-0.2 text-[0.6rem] font-extrabold text-white">
                                  Active
                                </span>
                              )}
                            </div>
                            <p className="text-[0.7rem] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
                              {meta.description}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
