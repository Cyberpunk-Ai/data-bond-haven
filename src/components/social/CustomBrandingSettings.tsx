import { useState } from "react";
import { Sparkles, Palette, Check, Lock, ShieldCheck, Eye } from "lucide-react";
import { useBranding, BRANDING_THEMES, type AuraThemeId } from "@/lib/branding-state";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { currentUser } from "@/lib/profile-service";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function CustomBrandingSettings() {
  const { currentPlan, isPlus, isPro } = usePlan();
  const { branding, activeTheme, updateBranding } = useBranding();

  const [taglineDraft, setTaglineDraft] = useState(branding.tagline);
  const [showAuraOnPosts, setShowAuraOnPosts] = useState(branding.showAuraOnPosts);

  const handleSelectTheme = (themeId: AuraThemeId) => {
    if (!isPlus) {
      openUpgradeModal("Custom Branding Themes");
      return;
    }
    updateBranding({ themeId });
    toast.success(`Applied ${BRANDING_THEMES[themeId].name} Theme Aura! ✨`);
  };

  const handleSaveTagline = () => {
    if (!isPlus) {
      openUpgradeModal("Custom Creator Tagline");
      return;
    }
    updateBranding({ tagline: taglineDraft.trim() });
    toast.success("Saved creator tagline!");
  };

  const handleToggleAura = (enabled: boolean) => {
    if (!isPlus) {
      openUpgradeModal("Custom Post Aura");
      return;
    }
    setShowAuraOnPosts(enabled);
    updateBranding({ showAuraOnPosts: enabled });
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div>
        <h2 className="text-xl font-black">Custom Branding & Aura</h2>
        <p className="text-xs text-muted-foreground">
          Elevate your identity with custom neon gradients, signature profile borders, and creator
          badges.
        </p>
      </div>

      {/* Live Preview Card */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" /> Live Profile Card Preview
          </span>
          <span className="text-xs font-semibold text-brand">Theme: {activeTheme.name}</span>
        </div>

        {/* Profile Card Mock */}
        <div
          className={cn(
            "relative overflow-hidden rounded-3xl border-2 bg-card p-5 transition-all duration-300",
            activeTheme.borderClass,
            activeTheme.glowClass,
          )}
        >
          <div
            className={cn(
              "absolute top-0 left-0 right-0 h-20 bg-gradient-to-r opacity-90",
              activeTheme.gradient,
            )}
          />
          <div className="relative pt-10 flex items-end justify-between gap-3">
            <Avatar
              name={currentUser.display_name}
              src={currentUser.avatar_url}
              className="h-16 w-16 text-lg ring-4 ring-card"
            />
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs font-extrabold tracking-wide uppercase shadow-xs",
                activeTheme.badgeBg,
              )}
            >
              {isPro ? "👑 Pro Creator" : isPlus ? "✨ Plus Creator" : "Free Member"}
            </span>
          </div>

          <div className="mt-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base">{currentUser.display_name}</span>
              <UserBadge isMe verified size="xs" />
            </div>
            <p className="text-xs text-muted-foreground">@{currentUser.username}</p>
            <p className="text-xs font-medium text-foreground/90 italic pt-1">
              "{branding.tagline || "Verified Creator on Spaces1"}"
            </p>
          </div>
        </div>
      </div>

      {/* Aura Theme Selector */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <h3 className="text-base font-bold flex items-center gap-2">
          <Palette className="h-4 w-4 text-brand" />
          <span>Select Profile Aura Theme</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(Object.keys(BRANDING_THEMES) as AuraThemeId[]).map((themeKey) => {
            const t = BRANDING_THEMES[themeKey];
            const isSelected = branding.themeId === themeKey;

            return (
              <button
                key={themeKey}
                type="button"
                onClick={() => handleSelectTheme(themeKey)}
                className={cn(
                  "relative flex items-center gap-3 rounded-2xl border-2 p-3.5 text-left transition-all cursor-pointer",
                  isSelected
                    ? cn("border-foreground shadow-md bg-muted/30", t.borderClass)
                    : "border-border/60 hover:border-border hover:bg-muted/10",
                )}
              >
                <div
                  className={cn(
                    "h-9 w-9 shrink-0 rounded-full bg-gradient-to-br shadow-xs",
                    t.gradient,
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-extrabold text-foreground">{t.name}</p>
                  <p className="text-[0.65rem] text-muted-foreground">Glow & banner accent</p>
                </div>
                {isSelected && (
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background">
                    <Check className="h-3 w-3 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Creator Tagline & Post Aura Toggles */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-3 shadow-soft">
          <h3 className="text-sm font-bold">Custom Creator Tagline</h3>
          <p className="text-xs text-muted-foreground">
            A verified subtitle displayed under your name on feeds and live rooms.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              maxLength={60}
              value={taglineDraft}
              onChange={(e) => setTaglineDraft(e.target.value)}
              placeholder="e.g., Host of Tech & Culture"
              className="flex-1 rounded-2xl bg-muted/40 border border-border px-3.5 py-2 text-xs font-medium outline-none focus:border-brand"
            />
            <button
              onClick={handleSaveTagline}
              className="rounded-2xl bg-gradient-to-r from-brand to-brand-pink px-4 py-2 text-xs font-bold text-white hover:brightness-105 transition-all cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-3 shadow-soft">
          <h3 className="text-sm font-bold">Post Card Highlight Glow</h3>
          <p className="text-xs text-muted-foreground">
            Render your custom aura glow on all posts you publish to the home feed.
          </p>
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs font-semibold text-foreground">Post Aura Enabled</span>
            <button
              type="button"
              onClick={() => handleToggleAura(!showAuraOnPosts)}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out",
                showAuraOnPosts ? "bg-brand" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out",
                  showAuraOnPosts ? "translate-x-5" : "translate-x-0",
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Free Tier Lock Barrier */}
      {!isPlus && (
        <div className="rounded-3xl border border-violet-500/30 bg-gradient-to-r from-violet-500/10 via-pink-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-violet-500" />
              <h4 className="text-sm font-black">Custom Branding is a Plus & Pro Feature</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Unlock neon theme auras, custom profile badges, and post glow styling.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("Custom Branding")}
            className="rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Upgrade to Plus ($9/mo)
          </button>
        </div>
      )}
    </div>
  );
}
