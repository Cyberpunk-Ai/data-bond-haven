import { useState, useEffect } from "react";
import {
  Sliders,
  Shield,
  Zap,
  Radio,
  Sparkles,
  Save,
  CheckCircle2,
  RefreshCw,
  Bell,
  AlertTriangle,
  Lock,
  Upload,
  Layers,
  ChevronRight,
  Database,
  Cloud,
  Server,
} from "lucide-react";
import { getAdminSettings, updateAdminSettings, syncSupabaseDatabase } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import type { SystemSettings, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AdminSystemSettingsTabProps {
  activeRole: UserRole;
  currentUserId: string;
}

export function AdminSystemSettingsTab({ activeRole, currentUserId }: AdminSystemSettingsTabProps) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingDb, setSyncingDb] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    counts: Record<string, number>;
    durationMs: number;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleSyncDatabase = async () => {
    try {
      setSyncingDb(true);
      const res = await syncSupabaseDatabase();
      setSyncResult({ counts: res.counts, durationMs: res.durationMs });
      toast.success(`Remote Supabase database synchronized (${res.durationMs}ms)`);
    } catch (err: any) {
      toast.error(err.message || "Failed to sync remote database");
    } finally {
      setSyncingDb(false);
    }
  };

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await getAdminSettings();
      setSettings(res);
    } catch (err) {
      console.error("Failed to load admin settings", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  useRealtime({
    "settings:updated": (updated: SystemSettings) => {
      setSettings(updated);
    },
  });

  const showToast = (msg: string) => {
    setToastMessage(msg);
    toast.success(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      const updated = await updateAdminSettings(settings, currentUserId);
      setSettings(updated);
      showToast("Platform system settings & banner published live");
    } catch (err: any) {
      toast.error(err.message || "Failed to update settings");
    } finally {
      setSaving(false);
    }
  };

  const canEditSettings = ["superadmin", "admin"].includes(activeRole);

  if (loading || !settings) {
    return (
      <div className="glass-panel py-16 text-center text-muted-foreground rounded-3xl">
        <RefreshCw className="mx-auto h-6 w-6 animate-spin text-brand mb-2" />
        Loading system configuration...
      </div>
    );
  }

  const banner = settings.announcement_banner;

  return (
    <div className="space-y-6">
      {/* Toast Notice */}
      {toastMessage && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-800 dark:text-emerald-200 shadow-soft animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Global Feature Flags */}
      <div className="glass-panel rounded-3xl border border-border/80 p-6 shadow-soft space-y-6">
        <div>
          <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
            <Sliders className="h-4 w-4 text-brand" />
            Core Platform Feature Toggles
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enable or disable major subsystems with instant zero-downtime server-side enforcement
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Maintenance Mode */}
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-foreground/5 p-4">
            <div>
              <div className="flex items-center gap-1.5 font-bold text-xs text-foreground">
                <Lock className="h-3.5 w-3.5 text-rose-500" />
                <span>Maintenance Mode</span>
              </div>
              <p className="text-[0.72rem] text-muted-foreground mt-1">
                Restricts non-admin access and displays maintenance banner
              </p>
            </div>
            <input
              type="checkbox"
              disabled={!canEditSettings}
              checked={settings.maintenance_mode}
              onChange={(e) => setSettings({ ...settings, maintenance_mode: e.target.checked })}
              className="h-5 w-5 rounded accent-rose-600 cursor-pointer disabled:opacity-50"
            />
          </div>

          {/* Registration Enabled */}
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-foreground/5 p-4">
            <div>
              <div className="flex items-center gap-1.5 font-bold text-xs text-foreground">
                <Shield className="h-3.5 w-3.5 text-emerald-500" />
                <span>New User Registration</span>
              </div>
              <p className="text-[0.72rem] text-muted-foreground mt-1">
                Allow new accounts to sign up on the platform
              </p>
            </div>
            <input
              type="checkbox"
              disabled={!canEditSettings}
              checked={settings.registration_enabled}
              onChange={(e) => setSettings({ ...settings, registration_enabled: e.target.checked })}
              className="h-5 w-5 rounded accent-brand cursor-pointer disabled:opacity-50"
            />
          </div>

          {/* AI Generation */}
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-foreground/5 p-4">
            <div>
              <div className="flex items-center gap-1.5 font-bold text-xs text-foreground">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                <span>AI Drafting & Gemini Services</span>
              </div>
              <p className="text-[0.72rem] text-muted-foreground mt-1">
                Enable AI story creation and smart post drafting assistants
              </p>
            </div>
            <input
              type="checkbox"
              disabled={!canEditSettings}
              checked={settings.ai_generation_enabled}
              onChange={(e) =>
                setSettings({ ...settings, ai_generation_enabled: e.target.checked })
              }
              className="h-5 w-5 rounded accent-brand cursor-pointer disabled:opacity-50"
            />
          </div>

          {/* Audio Spaces */}
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-foreground/5 p-4">
            <div>
              <div className="flex items-center gap-1.5 font-bold text-xs text-foreground">
                <Radio className="h-3.5 w-3.5 text-rose-500" />
                <span>Live Audio Spaces Subsystem</span>
              </div>
              <p className="text-[0.72rem] text-muted-foreground mt-1">
                Enable live voice broadcasts and audience participation
              </p>
            </div>
            <input
              type="checkbox"
              disabled={!canEditSettings}
              checked={settings.spaces_audio_enabled}
              onChange={(e) => setSettings({ ...settings, spaces_audio_enabled: e.target.checked })}
              className="h-5 w-5 rounded accent-brand cursor-pointer disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* Platform Capacity & Moderation Strictness */}
      <div className="glass-panel rounded-3xl border border-border/80 p-6 shadow-soft space-y-6">
        <div>
          <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            Platform Thresholds & Auto-Moderation
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure safety thresholds and bandwidth protection limits
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-foreground/5 p-4">
            <label className="text-xs font-bold text-foreground block">Max Upload Size (MB)</label>
            <p className="text-[0.7rem] text-muted-foreground mt-0.5 mb-2">
              Maximum allowed payload for media attachments
            </p>
            <input
              type="number"
              disabled={!canEditSettings}
              value={settings.max_upload_size_mb}
              onChange={(e) =>
                setSettings({ ...settings, max_upload_size_mb: Number(e.target.value) })
              }
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-bold text-foreground focus:outline-none"
            />
          </div>

          <div className="rounded-2xl border border-border bg-foreground/5 p-4">
            <label className="text-xs font-bold text-foreground block">
              Rate Limit (Req / Min)
            </label>
            <p className="text-[0.7rem] text-muted-foreground mt-0.5 mb-2">
              Per-IP request ceiling to prevent API abuse
            </p>
            <input
              type="number"
              disabled={!canEditSettings}
              value={settings.rate_limit_requests_per_min}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  rate_limit_requests_per_min: Number(e.target.value),
                })
              }
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-bold text-foreground focus:outline-none"
            />
          </div>

          <div className="rounded-2xl border border-border bg-foreground/5 p-4">
            <label className="text-xs font-bold text-foreground block">Auto-Mod Strictness</label>
            <p className="text-[0.7rem] text-muted-foreground mt-0.5 mb-2">
              Heuristic severity for automated content flagging
            </p>
            <select
              disabled={!canEditSettings}
              value={settings.auto_mod_strictness}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  auto_mod_strictness: e.target.value as any,
                })
              }
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-bold text-foreground focus:outline-none capitalize"
            >
              <option value="low">Low (Minimal Filter)</option>
              <option value="medium">Medium (Standard)</option>
              <option value="high">High (Aggressive)</option>
              <option value="strict">Strict (Maximum Shield)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Database & Cloud Infrastructure Manager */}
      <div className="glass-panel rounded-3xl border border-border/80 p-6 shadow-soft space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-500" />
              Database Drivers & Supabase Cloud Sync
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live database synchronization with remote Supabase PostgreSQL tables, Auth, and
              Storage
            </p>
          </div>

          <button
            onClick={handleSyncDatabase}
            disabled={syncingDb}
            className="flex items-center gap-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 px-4 py-2 text-xs font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition-all shadow-xs disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", syncingDb && "animate-spin text-emerald-500")}
            />
            <span>{syncingDb ? "Synchronizing..." : "Sync Remote Database"}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-foreground/5 p-4 space-y-1">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-emerald-500" />
              <span className="text-xs font-bold text-foreground">Active Database Driver</span>
            </div>
            <p className="text-sm font-black text-emerald-600 dark:text-emerald-400 capitalize">
              Supabase PostgreSQL
            </p>
            <p className="text-[0.7rem] text-muted-foreground">13 tables verified & operational</p>
          </div>

          <div className="rounded-2xl border border-border bg-foreground/5 p-4 space-y-1">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-brand" />
              <span className="text-xs font-bold text-foreground">Storage Buckets</span>
            </div>
            <p className="text-sm font-black text-foreground">Supabase Storage</p>
            <p className="text-[0.7rem] text-muted-foreground">
              avatars, posts, media, spaces, public-assets
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-foreground/5 p-4 space-y-1">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-violet-500" />
              <span className="text-xs font-bold text-foreground">Realtime Engine</span>
            </div>
            <p className="text-sm font-black text-foreground">Supabase Broadcast & SSE</p>
            <p className="text-[0.7rem] text-muted-foreground">Sub-millisecond pub/sub channel</p>
          </div>
        </div>

        {syncResult && (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2 text-xs animate-in fade-in">
            <div className="flex items-center justify-between font-bold text-emerald-700 dark:text-emerald-300">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Latest Database Sync Summary ({syncResult.durationMs}ms)
              </span>
              <span className="text-[0.7rem] opacity-75">Just now</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[0.75rem]">
              {Object.entries(syncResult.counts).map(([table, count]) => (
                <div key={table} className="rounded-xl bg-card/80 p-2 border border-border/60">
                  <span className="text-muted-foreground uppercase text-[0.65rem] font-bold block">
                    {table}
                  </span>
                  <span className="text-sm font-black text-foreground">{count} records</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Platform Announcement Banner Manager */}
      <div className="glass-panel rounded-3xl border border-border/80 p-6 shadow-soft space-y-6">
        <div>
          <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
            <Bell className="h-4 w-4 text-brand" />
            Live Platform Announcement Broadcast
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Broadcast a real-time banner across all active users in the platform header
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-2xl border border-border bg-foreground/5 p-4">
            <div>
              <span className="text-xs font-bold text-foreground">
                Activate Global Announcement
              </span>
              <p className="text-[0.7rem] text-muted-foreground mt-0.5">
                Displays the alert at the top of every page for all signed-in and guest users
              </p>
            </div>
            <input
              type="checkbox"
              disabled={!canEditSettings}
              checked={banner.active}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  announcement_banner: { ...banner, active: e.target.checked },
                })
              }
              className="h-5 w-5 rounded accent-brand cursor-pointer disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-bold text-foreground block mb-1">
                Announcement Message
              </label>
              <input
                type="text"
                disabled={!canEditSettings}
                value={banner.message}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    announcement_banner: { ...banner, message: e.target.value },
                  })
                }
                placeholder="e.g. Welcome to Spaces1! Join our live audio session today."
                className="w-full rounded-2xl border border-border bg-background px-3.5 py-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-foreground block mb-1">
                  Alert Severity
                </label>
                <select
                  disabled={!canEditSettings}
                  value={banner.type}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      announcement_banner: { ...banner, type: e.target.value as any },
                    })
                  }
                  className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-xs font-semibold text-foreground focus:outline-none capitalize"
                >
                  <option value="info">Info (Violet/Blue)</option>
                  <option value="warning">Warning (Amber)</option>
                  <option value="success">Success (Emerald)</option>
                  <option value="critical">Critical (Rose)</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-foreground block mb-1">
                  Destination Link
                </label>
                <input
                  type="text"
                  disabled={!canEditSettings}
                  value={banner.link || ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      announcement_banner: { ...banner, link: e.target.value },
                    })
                  }
                  placeholder="e.g. /spaces"
                  className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Live Preview Box */}
          <div className="rounded-2xl border border-border/60 bg-foreground/5 p-4">
            <p className="text-[0.68rem] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Real-time Preview (As rendered on user screens)
            </p>
            <div
              className={cn(
                "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-xs shadow-soft",
                {
                  info: "bg-violet-500/15 border-violet-500/30 text-violet-900 dark:text-violet-100",
                  warning: "bg-amber-500/15 border-amber-500/30 text-amber-900 dark:text-amber-100",
                  success:
                    "bg-emerald-500/15 border-emerald-500/30 text-emerald-900 dark:text-emerald-100",
                  critical: "bg-rose-500/15 border-rose-500/30 text-rose-900 dark:text-rose-100",
                }[banner.type || "info"],
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-bold uppercase text-[0.65rem] px-2 py-0.5 rounded-full bg-background/50">
                  {banner.type}
                </span>
                <span className="font-medium">
                  {banner.message || "Enter a broadcast message above"}
                </span>
              </div>
              {banner.link && (
                <span className="flex items-center gap-0.5 rounded-xl bg-background/80 px-2 py-0.5 text-[0.65rem] font-bold">
                  <span>Open {banner.link}</span>
                  <ChevronRight className="h-3 w-3" />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Save Trigger */}
      {canEditSettings && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-6 py-3 font-bold text-white shadow-soft transition-all hover:shadow-glow active:scale-[0.98] disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            <span>{saving ? "Publishing Changes..." : "Publish Platform Configuration"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
