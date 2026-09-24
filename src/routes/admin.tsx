import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState, lazy, Suspense } from "react";

import { AdminAuditLogsTab } from "@/components/admin/AdminAuditLogsTab";
import { AdminContentTab } from "@/components/admin/AdminContentTab";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { AdminModerationTab } from "@/components/admin/AdminModerationTab";
import { AdminPayoutsTab } from "@/components/admin/AdminPayoutsTab";
import { AdminSystemSettingsTab } from "@/components/admin/AdminSystemSettingsTab";
import { AdminUsersTab } from "@/components/admin/AdminUsersTab";
import { getAdminOverview } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-state";
import { supabase } from "@/integrations/supabase/client";
import { currentUser } from "@/lib/profile-service";
import type { AdminOverviewData, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const AdminOverviewTab = lazy(() =>
  import("@/components/admin/AdminOverviewTab").then((m) => ({ default: m.AdminOverviewTab })),
);

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin Console — Spaces1" },
      {
        name: "description",
        content:
          "Moderation queue, user management, content review, audit logs and platform settings for Spaces administrators.",
      },
      { property: "og:title", content: "Admin Console — Spaces1" },
      {
        property: "og:description",
        content: "Moderation, users, content, audit logs and platform settings.",
      },
      { property: "og:type", content: "website" },
      { name: "robots", content: "noindex" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPage,
});

const TABS = [
  "overview",
  "users",
  "content",
  "moderation",
  "withdrawals",
  "audit",
  "settings",
] as const;

function AdminPage() {
  const { user } = useAuth();
  const profile = user || currentUser;
  const [activeRole, setActiveRole] = useState<UserRole>("moderator");
  const [tab, setTab] = useState<(typeof TABS)[number]>("overview");
  const [overview, setOverview] = useState<AdminOverviewData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [access, setAccess] = useState<"checking" | "granted" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Access is decided by the account's real role on the server. There are
      // no name, email or "allow anyway" shortcuts.
      const { data: sessionData } = await supabase.auth.getUser();
      const authUserId = sessionData?.user?.id;
      if (!authUserId) {
        if (!cancelled) setAccess("denied");
        return;
      }

      try {
        const [{ data: isAdmin }, { data: isMod }] = await Promise.all([
          supabase.rpc("has_role", { _user_id: authUserId, _role: "admin" }),
          supabase.rpc("has_role", { _user_id: authUserId, _role: "moderator" }),
        ]);
        if (cancelled) return;
        if (isAdmin) {
          setActiveRole("admin");
          setAccess("granted");
        } else if (isMod) {
          setActiveRole("moderator");
          setAccess("granted");
        } else {
          setAccess("denied");
        }
      } catch {
        if (!cancelled) setAccess("denied");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setOverview(await getAdminOverview());
    } catch {
      setOverview(null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (access === "granted") void load();
  }, [load, access]);

  if (access !== "granted") {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-extrabold">
          {access === "checking" ? "Checking access…" : "Admin access required"}
        </h1>
        {access === "denied" ? (
          <p className="text-sm text-muted-foreground">
            This console is limited to Spaces1 administrators and moderators. Sign in with an
            account that has been given access to continue.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <AdminHeader
        currentProfile={profile}
        activeRole={activeRole}
        onRoleChange={(next) => {
          // Staff can only preview access levels at or below their own; the
          // server re-checks the real role on every action regardless.
          if (activeRole === "admin") setActiveRole(next);
        }}
        systemHealth={overview?.stats.system_health}
        onRefresh={load}
        isRefreshing={refreshing}
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-xs font-bold capitalize transition-colors",
              tab === t
                ? "border-brand bg-brand/10 text-brand"
                : "border-border text-muted-foreground hover:bg-foreground/5",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "overview" && overview && (
        <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
          <AdminOverviewTab
            overview={overview}
            activeRole={activeRole}
            onNavigateTab={(t) => setTab(t as any)}
          />
        </Suspense>
      )}
      {tab === "users" && <AdminUsersTab activeRole={activeRole} currentUserId={profile.id} />}
      {tab === "content" && <AdminContentTab activeRole={activeRole} currentUserId={profile.id} />}
      {tab === "moderation" && (
        <AdminModerationTab activeRole={activeRole} currentUserId={profile.id} />
      )}
      {tab === "withdrawals" && <AdminPayoutsTab />}
      {tab === "audit" && <AdminAuditLogsTab activeRole={activeRole} />}
      {tab === "settings" && (
        <AdminSystemSettingsTab activeRole={activeRole} currentUserId={profile.id} />
      )}
    </div>
  );
}
