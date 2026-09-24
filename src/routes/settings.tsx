import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  User,
  Bell,
  Lock,
  Palette,
  Shield,
  ChevronRight,
  Check,
  LogOut,
  CreditCard,
  Sparkles,
  Zap,
  Crown,
  CheckCircle2,
  ArrowUpRight,
  Camera,
  Loader2,
  TrendingUp,
  DollarSign,
  Users,
  Headphones,
  Sun,
  Moon,
  Monitor,
  Code,
} from "lucide-react";
import { AppShell, PageHeader, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { MonetizationHub } from "@/components/social/MonetizationHub";
import { CustomBrandingSettings } from "@/components/social/CustomBrandingSettings";
import { TeamWorkspaceManager } from "@/components/social/TeamWorkspaceManager";
import { DeveloperPortal } from "@/components/social/DeveloperPortal";
import { PrioritySupportDesk } from "@/components/social/PrioritySupportDesk";
import { currentUser } from "@/lib/profile-service";
import { setLoggedOut, useAuth, updateUserSession } from "@/lib/auth-state";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { useTheme, ACCENT_PALETTES, type ThemeAccent, type ThemeMode } from "@/lib/theme-state";
import { usePreferences } from "@/lib/preferences-state";
import { PLAN_DETAILS, type PlanTier } from "@/lib/plans";
import { PaymentHistory } from "@/components/social/PaymentHistory";
import { cn } from "@/lib/utils";

import { toast } from "sonner";
import { updateUserProfile, uploadMedia } from "@/lib/api-client";

const AnalyticsDashboard = lazy(() =>
  import("@/components/social/AnalyticsDashboard").then((m) => ({ default: m.AnalyticsDashboard })),
);

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Spaces1" },
      {
        name: "description",
        content:
          "Manage your Spaces1 account: profile details, notification preferences, privacy controls, appearance, and creator tools.",
      },
      { property: "og:title", content: "Settings — Spaces1" },
      {
        property: "og:description",
        content:
          "Profile, notifications, privacy, appearance, and creator controls for your Spaces1 account.",
      },
    ],
  }),
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { section?: string } => ({
    section: typeof search.section === "string" ? search.section : undefined,
  }),
});

const sections: Array<{
  id: string;
  label: string;
  icon: any;
  tier?: "plus" | "pro";
}> = [
  { id: "profile", label: "Profile", icon: User },
  { id: "plan", label: "Plan & Billing", icon: CreditCard },
  { id: "analytics", label: "Creator Analytics", icon: TrendingUp, tier: "plus" },
  { id: "monetization", label: "Monetization & Tips", icon: DollarSign, tier: "plus" },
  { id: "branding", label: "Custom Branding", icon: Sparkles, tier: "plus" },
  { id: "workspaces", label: "Team Workspaces", icon: Users, tier: "pro" },
  { id: "developer", label: "Developer API", icon: Code, tier: "pro" },
  { id: "support", label: "Priority VIP Support", icon: Headphones, tier: "pro" },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "privacy", label: "Privacy & safety", icon: Lock },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: Shield },
];

type SectionId = (typeof sections)[number]["id"];

/**
 * Each on/off preference is stored on the signed-in account, so it survives a
 * refresh and follows the person to another device.
 */
function usePersistentToggle(key: string, defaultValue: boolean) {
  const { toggle: read, setToggle } = usePreferences();
  const val = read(key, defaultValue);

  const set = (next: boolean) => {
    void setToggle(key, next).then((res) => {
      if (res.ok) toast.success("Preference saved");
      else toast.error(res.error || "That change didn't save. Please try again.");
    });
  };

  return [val, set] as const;
}

function Toggle({
  label,
  description,
  defaultOn = false,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  defaultOn?: boolean;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const [internalOn, setInternalOn] = useState(defaultOn);
  const on = checked !== undefined ? checked : internalOn;

  const handleToggle = () => {
    if (onChange) {
      onChange(!on);
    } else {
      setInternalOn(!on);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl p-3 transition-colors duration-300 hover:bg-foreground/5">
      <div className="min-w-0">
        <p className="text-sm font-bold">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={handleToggle}
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300",
          on ? "bg-gradient-to-r from-brand to-brand-pink" : "bg-foreground/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-300",
            on ? "translate-x-[1.4rem]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

function SettingsPage() {
  const navigate = useNavigate();
  const { section } = Route.useSearch();
  const { user } = useAuth();
  const {
    currentPlan,
    planDetails,
    billingCycle,
    isPro,
    isUltra,
    usage,
    updateBillingCycle,
    upgradePlan,
    cancelSubscription,
  } = usePlan();
  const {
    mode,
    setMode,
    accent,
    setAccent,
    reduceMotion,
    setReduceMotion,
    largerText,
    setLargerText,
  } = useTheme();
  const validSection = (id?: string): id is SectionId =>
    Boolean(id) && sections.some((s) => s.id === id);
  const [active, setActive] = useState<SectionId>(validSection(section) ? section : "profile");
  useEffect(() => {
    if (validSection(section)) setActive(section);
  }, [section]);
  const [saved, setSaved] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persistent notification preferences
  const [notifyLikes, setNotifyLikes] = usePersistentToggle("notify_likes", true);
  const [notifyFollowers, setNotifyFollowers] = usePersistentToggle("notify_followers", true);
  const [notifyMentions, setNotifyMentions] = usePersistentToggle("notify_mentions", true);
  const [notifySpaces, setNotifySpaces] = usePersistentToggle("notify_spaces", false);
  const [notifyDigest, setNotifyDigest] = usePersistentToggle("notify_digest", false);

  // Persistent privacy preferences
  const [privAccount, setPrivAccount] = usePersistentToggle("priv_account", false);
  const [hideActivity, setHideActivity] = usePersistentToggle("hide_activity", false);
  const [filterSensitive, setFilterSensitive] = usePersistentToggle("filter_sensitive", true);
  const [allowRequests, setAllowRequests] = usePersistentToggle("allow_requests", true);

  const activeUser = user || currentUser;
  const [form, setForm] = useState({
    name: activeUser.display_name,
    username: activeUser.username,
    bio: activeUser.bio,
    location: activeUser.location || "",
    website: activeUser.website || "",
    avatar_url: activeUser.avatar_url || "",
  });

  useEffect(() => {
    if (activeUser) {
      setForm({
        name: activeUser.display_name,
        username: activeUser.username,
        bio: activeUser.bio,
        location: activeUser.location || "",
        website: activeUser.website || "",
        avatar_url: activeUser.avatar_url || "",
      });
    }
  }, [
    activeUser.display_name,
    activeUser.username,
    activeUser.bio,
    activeUser.location,
    activeUser.website,
    activeUser.avatar_url,
  ]);

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingPhoto(true);
    try {
      toast.loading("Uploading photo...", { id: "avatar-upload" });
      const res = await uploadMedia(file, "avatars");
      const newAvatarUrl = res.url;
      setForm((prev) => ({ ...prev, avatar_url: newAvatarUrl }));

      // Update backend profile immediately
      await updateUserProfile({
        avatar_url: newAvatarUrl,
      });
      updateUserSession({ avatar_url: newAvatarUrl });
      toast.success("Profile photo updated!", { id: "avatar-upload" });
    } catch (err: any) {
      console.error("Avatar upload failed:", err);
      toast.error(err?.message || "Could not upload photo. Please try again.", {
        id: "avatar-upload",
      });
    } finally {
      e.target.value = "";
      setUploadingPhoto(false);
    }
  }

  async function save() {
    try {
      const updatedData = {
        display_name: form.name,
        username: form.username,
        bio: form.bio,
        location: form.location,
        website: form.website,
        avatar_url: form.avatar_url,
      };
      await updateUserProfile(updatedData);
      updateUserSession(updatedData);
      setSaved(true);
      toast.success("Profile settings saved successfully");
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      console.error("Failed to save profile settings:", err);
      const message = err instanceof Error ? err.message : undefined;
      toast.error(message || "Could not save your settings. Please try again.");
    }
  }

  return (
    <AppShell title="Settings">
      <div className="mx-auto max-w-4xl space-y-5">
        <PageHeader title="Settings" subtitle="Tune Spaces to fit the way you work." />

        <div className="grid gap-5 md:grid-cols-[15rem_1fr]">
          <Panel className="min-w-0 p-2 md:max-h-[calc(100vh-8.5rem)] md:overflow-y-auto custom-scrollbar">
            <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible pb-1 md:pb-0 [scrollbar-width:none]">
              {sections.map((s) => {
                const Icon = s.icon;
                const isActive = s.id === active;
                return (
                  <button
                    key={s.id}
                    onClick={() => setActive(s.id as SectionId)}
                    className={cn(
                      "flex shrink-0 md:w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-xs sm:text-sm font-semibold transition-all duration-300 cursor-pointer whitespace-nowrap",
                      isActive
                        ? "bg-gradient-to-r from-brand/15 to-brand-pink/15 text-brand font-bold shadow-xs"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{s.label}</span>
                    {s.tier && (
                      <span
                        className={cn(
                          "ml-auto text-[0.6rem] font-extrabold uppercase px-1.5 py-0.2 rounded-full shrink-0",
                          s.tier === "pro"
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-violet-500/15 text-violet-600 dark:text-violet-400",
                        )}
                      >
                        {s.tier}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        "hidden md:block ml-1 h-3.5 w-3.5 shrink-0 transition-transform duration-300",
                        isActive && "translate-x-0.5 text-brand",
                      )}
                    />
                  </button>
                );
              })}
            </nav>
          </Panel>

          <Panel
            className="min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 md:max-h-[calc(100vh-8.5rem)] md:overflow-y-auto custom-scrollbar"
            key={active}
          >
            {active === "profile" && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar
                    name={form.name || activeUser.display_name}
                    src={form.avatar_url || activeUser.avatar_url}
                    className="h-16 w-16 text-lg"
                  />
                  <div>
                    <p className="text-sm font-bold">Profile photo</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleAvatarUpload}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingPhoto}
                      className="mt-1.5 flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-bold transition-all duration-300 hover:bg-foreground/5 active:scale-95 disabled:opacity-50"
                    >
                      {uploadingPhoto ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Camera className="h-3.5 w-3.5" />
                      )}
                      {uploadingPhoto ? "Uploading..." : "Upload new"}
                    </button>
                  </div>
                </div>

                <TextField
                  label="Display name"
                  value={form.name}
                  onChange={(v) => setForm({ ...form, name: v })}
                />
                <TextField
                  label="Username"
                  value={form.username}
                  onChange={(v) => setForm({ ...form, username: v })}
                />
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Bio
                  </label>
                  <textarea
                    value={form.bio}
                    onChange={(e) => setForm({ ...form, bio: e.target.value })}
                    rows={3}
                    className="w-full resize-none rounded-2xl bg-foreground/5 px-4 py-3 text-sm outline-none transition-shadow duration-300 focus:shadow-glow"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Location"
                    value={form.location}
                    onChange={(v) => setForm({ ...form, location: v })}
                  />
                  <TextField
                    label="Website"
                    value={form.website}
                    onChange={(v) => setForm({ ...form, website: v })}
                  />
                </div>

                <button
                  onClick={save}
                  className="flex items-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-6 py-3 text-sm font-bold text-white shadow-soft transition-all duration-300 hover:shadow-glow active:scale-95"
                >
                  {saved ? <Check className="h-4 w-4" /> : null}
                  {saved ? "Saved" : "Save changes"}
                </button>
              </div>
            )}

            {active === "notifications" && (
              <div className="space-y-1">
                <Toggle
                  label="Likes and reposts"
                  description="Ping me when someone reacts to my posts."
                  checked={notifyLikes}
                  onChange={setNotifyLikes}
                />
                <Toggle
                  label="New followers"
                  description="Know when someone joins your audience."
                  checked={notifyFollowers}
                  onChange={setNotifyFollowers}
                />
                <Toggle
                  label="Mentions and replies"
                  description="Never miss a direct conversation."
                  checked={notifyMentions}
                  onChange={setNotifyMentions}
                />
                <Toggle
                  label="Live Spaces"
                  description="Alert me when people I follow go live."
                  checked={notifySpaces}
                  onChange={setNotifySpaces}
                />
                <Toggle
                  label="Email digest"
                  description="A weekly summary of what you missed."
                  checked={notifyDigest}
                  onChange={setNotifyDigest}
                />
              </div>
            )}

            {active === "privacy" && (
              <div className="space-y-1">
                <Toggle
                  label="Private account"
                  description="Only approved followers can see your posts."
                  checked={privAccount}
                  onChange={setPrivAccount}
                />
                <Toggle
                  label="Hide activity status"
                  description="Don't show when you were last online."
                  checked={hideActivity}
                  onChange={setHideActivity}
                />
                <Toggle
                  label="Filter sensitive content"
                  description="Blur media flagged by the community."
                  checked={filterSensitive}
                  onChange={setFilterSensitive}
                />
                <Toggle
                  label="Allow message requests"
                  description="Let people you don't follow reach you."
                  checked={allowRequests}
                  onChange={setAllowRequests}
                />
              </div>
            )}

            {active === "appearance" && (
              <div className="space-y-6">
                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Color Theme Mode
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { id: "light" as ThemeMode, label: "Light", icon: Sun },
                      { id: "dark" as ThemeMode, label: "Dark", icon: Moon },
                      { id: "system" as ThemeMode, label: "System", icon: Monitor },
                    ].map((m) => {
                      const Icon = m.icon;
                      const isSelected = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setMode(m.id)}
                          className={cn(
                            "flex flex-col items-center justify-center gap-2 rounded-2xl border p-4 transition-all duration-200",
                            isSelected
                              ? "border-brand bg-brand/10 text-brand shadow-xs font-bold"
                              : "border-border bg-card hover:bg-foreground/5 text-muted-foreground hover:text-foreground font-medium",
                          )}
                        >
                          <Icon
                            className={cn(
                              "h-5 w-5",
                              isSelected ? "text-brand" : "text-muted-foreground",
                            )}
                          />
                          <span className="text-xs">{m.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Brand Color Accent
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {(Object.keys(ACCENT_PALETTES) as ThemeAccent[]).map((paletteKey) => {
                      const palette = ACCENT_PALETTES[paletteKey];
                      const isSelected = accent === paletteKey;
                      return (
                        <button
                          key={paletteKey}
                          type="button"
                          onClick={() => setAccent(paletteKey)}
                          className={cn(
                            "flex items-center gap-3 rounded-2xl border p-3 text-left transition-all duration-200",
                            isSelected
                              ? "border-brand bg-brand/10 shadow-xs"
                              : "border-border bg-card hover:bg-foreground/5",
                          )}
                        >
                          <span
                            className={cn(
                              "h-7 w-7 shrink-0 rounded-full bg-gradient-to-br shadow-xs",
                              palette.gradientClass,
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "text-xs font-bold truncate",
                                isSelected ? "text-brand" : "text-foreground",
                              )}
                            >
                              {palette.name}
                            </p>
                          </div>
                          {isSelected && <Check className="h-4 w-4 text-brand shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1 pt-2 border-t border-border">
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Display Preferences
                  </label>
                  <Toggle
                    label="Reduce motion"
                    description="Minimise animation and transition effects."
                    checked={reduceMotion}
                    onChange={setReduceMotion}
                  />
                  <Toggle
                    label="Larger text"
                    description="Increase default base typography size for enhanced readability."
                    checked={largerText}
                    onChange={setLargerText}
                  />
                </div>
              </div>
            )}

            {active === "security" && (
              <div className="space-y-4">
                <div className="space-y-1">
                  <Toggle
                    label="Two-factor authentication"
                    description="Require a code at every new sign-in."
                    defaultOn
                  />
                  <Toggle
                    label="Login alerts"
                    description="Email me about new devices."
                    defaultOn
                  />
                </div>

                <div className="rounded-2xl bg-foreground/5 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-bold text-foreground">Active Session</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Logged in as{" "}
                        <strong className="text-foreground">{currentUser.display_name}</strong> (@
                        {currentUser.username})
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setLoggedOut();
                        navigate({ to: "/" });
                      }}
                      className="flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 px-4 py-2 text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-100 transition-colors active:scale-95"
                    >
                      <LogOut className="h-3.5 w-3.5" /> Sign out
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl bg-foreground/5 p-4 text-sm text-muted-foreground">
                  Security policies and session management are protected across your account.
                </div>
              </div>
            )}

            {/* Plan & Billing Tab */}
            {active === "plan" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold">Plan & Billing</h2>
                    <p className="text-xs text-muted-foreground">
                      Manage your subscription tier, billing cycle, and unlocked creator perks.
                    </p>
                  </div>

                  {/* Billing Cycle Switch */}
                  <div className="flex items-center gap-2 rounded-full border border-border bg-foreground/5 p-1 text-xs">
                    <button
                      type="button"
                      onClick={() => updateBillingCycle("monthly")}
                      className={cn(
                        "rounded-full px-3 py-1 font-semibold transition-all",
                        billingCycle === "monthly"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      onClick={() => updateBillingCycle("annual")}
                      className={cn(
                        "flex items-center gap-1 rounded-full px-3 py-1 font-semibold transition-all",
                        billingCycle === "annual"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span>Annual</span>
                      <span className="rounded-full bg-violet-100 dark:bg-violet-950/60 px-1.5 py-0.2 text-[0.65rem] font-extrabold text-violet-700 dark:text-violet-300">
                        -20%
                      </span>
                    </button>
                  </div>
                </div>

                {/* 3 Clean Pricing Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {(["free", "plus", "pro"] as const).map((tier) => {
                    const plan = PLAN_DETAILS[tier];
                    const isCurrent = currentPlan === tier;
                    const price = billingCycle === "annual" ? plan.priceAnnual : plan.priceMonthly;

                    return (
                      <div
                        key={tier}
                        className={cn(
                          "relative flex flex-col rounded-3xl p-5 transition-all duration-300",
                          isCurrent
                            ? "border-2 border-brand/60 bg-brand/5 shadow-soft ring-2 ring-brand/20"
                            : plan.popular
                              ? "border border-violet-500/30 bg-card shadow-xs"
                              : "border border-border bg-card",
                        )}
                      >
                        {plan.popular && !isCurrent && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider text-white shadow-xs">
                            Most popular
                          </span>
                        )}

                        <div className="flex items-center justify-between">
                          <h4 className="text-lg font-black">{plan.name}</h4>
                          {plan.badge ? (
                            <span
                              className={cn(
                                "text-[0.65rem] px-2 py-0.5 rounded-full",
                                plan.badgeColor,
                              )}
                            >
                              {plan.badge}
                            </span>
                          ) : (
                            <span className="text-[0.65rem] text-muted-foreground font-semibold">
                              Standard
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{plan.tagline}</p>

                        <div className="my-4">
                          <div className="flex items-baseline gap-1">
                            <span className="text-3xl font-black">${price}</span>
                            <span className="text-xs text-muted-foreground">
                              /mo{billingCycle === "annual" && price > 0 ? ", billed annually" : ""}
                            </span>
                          </div>
                        </div>

                        <div className="border-t border-border/60 pt-3 pb-4 flex-1">
                          <ul className="space-y-2 text-xs">
                            {plan.features.map((f) => (
                              <li key={f} className="flex items-start gap-2">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                                <span className="text-foreground/90 font-medium">{f}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <button
                          type="button"
                          disabled={isCurrent}
                          onClick={() => {
                            if (tier === "free") {
                              if (confirm("Downgrade to the Free plan?")) {
                                cancelSubscription();
                              }
                            } else {
                              openUpgradeModal(
                                tier === "plus" ? "Upgrade to Plus" : "Upgrade to Pro",
                              );
                            }
                          }}
                          className={cn(
                            "w-full rounded-2xl py-2.5 text-center text-xs font-bold transition-all duration-300",
                            isCurrent
                              ? "bg-muted text-muted-foreground border border-border cursor-default"
                              : plan.popular
                                ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-xs hover:brightness-105"
                                : "border border-border bg-foreground/5 hover:bg-foreground/10 text-foreground",
                          )}
                        >
                          {isCurrent
                            ? "Current Plan"
                            : tier === "free"
                              ? "Switch to Free"
                              : `Get ${plan.name}`}
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Quota & Usage Meter */}
                <div className="rounded-3xl border border-border bg-card p-5 space-y-4 shadow-soft">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold">Active Tier Quotas</h4>
                      <p className="text-xs text-muted-foreground">
                        Daily and monthly allowance for your current plan.
                      </p>
                    </div>
                    <Link
                      to="/pricing"
                      className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                    >
                      View All Perks <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-2xl bg-foreground/[0.03] p-3.5 border border-border/50">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-semibold">
                          Gemini AI Drafts
                        </span>
                        <span className="font-bold">
                          {usage.aiDraftsToday || 0} /{" "}
                          {planDetails.limits.aiDraftsPerDay > 1000
                            ? "∞"
                            : planDetails.limits.aiDraftsPerDay}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                        <div
                          className="h-full bg-gradient-to-r from-brand to-brand-pink"
                          style={{
                            width: `${Math.min(100, ((usage.aiDraftsToday || 0) / (planDetails.limits.aiDraftsPerDay || 1)) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl bg-foreground/[0.03] p-3.5 border border-border/50">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-semibold">Spaces Audience</span>
                        <span className="font-bold">
                          {planDetails.limits.spacesMaxListeners} max
                        </span>
                      </div>
                      <p className="mt-2 text-[0.7rem] text-emerald-600 dark:text-emerald-400 font-medium truncate">
                        {planDetails.limits.spacesAudioQuality}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-foreground/[0.03] p-3.5 border border-border/50">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-semibold">Upload Limit</span>
                        <span className="font-bold">
                          {planDetails.limits.mediaUploadMaxMb}MB Media
                        </span>
                      </div>
                      <p className="mt-2 text-[0.7rem] text-muted-foreground font-medium">
                        {planDetails.limits.supportLevel}
                      </p>
                    </div>
                  </div>
                </div>

                <PaymentHistory />
              </div>
            )}

            {active === "analytics" && (
              <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
                <AnalyticsDashboard />
              </Suspense>
            )}
            {active === "monetization" && <MonetizationHub />}
            {active === "branding" && <CustomBrandingSettings />}
            {active === "workspaces" && <TeamWorkspaceManager />}
            {active === "developer" && <DeveloperPortal />}
            {active === "support" && <PrioritySupportDesk />}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl bg-foreground/5 px-4 py-3 text-sm outline-none transition-shadow duration-300 focus:shadow-glow"
      />
    </div>
  );
}
