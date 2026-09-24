import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { getPublicSettings } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import type { SystemSettings } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AnnouncementBanner() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    getPublicSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  useRealtime({
    "settings:updated": (updated: SystemSettings) => {
      setSettings(updated);
      setDismissed(false);
    },
  });

  if (!settings) return null;

  const banner = settings.announcement_banner;
  if (!banner || !banner.active || dismissed) return null;

  const typeConfig = {
    info: {
      bg: "bg-gradient-to-r from-violet-600/15 via-purple-600/10 to-indigo-600/15 border-violet-500/30 text-violet-950 dark:text-violet-100",
      icon: Info,
      iconColor: "text-violet-600 dark:text-violet-400",
      badge: "Platform Notice",
      badgeColor: "bg-violet-500/20 text-violet-700 dark:text-violet-300",
    },
    warning: {
      bg: "bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-yellow-500/15 border-amber-500/30 text-amber-950 dark:text-amber-100",
      icon: AlertTriangle,
      iconColor: "text-amber-600 dark:text-amber-400",
      badge: "Advisory",
      badgeColor: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
    },
    success: {
      bg: "bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-green-500/15 border-emerald-500/30 text-emerald-950 dark:text-emerald-100",
      icon: CheckCircle2,
      iconColor: "text-emerald-600 dark:text-emerald-400",
      badge: "Release Update",
      badgeColor: "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300",
    },
    critical: {
      bg: "bg-gradient-to-r from-rose-500/20 via-red-500/15 to-pink-500/20 border-rose-500/40 text-rose-950 dark:text-rose-100",
      icon: ShieldAlert,
      iconColor: "text-rose-600 dark:text-rose-400",
      badge: "Urgent",
      badgeColor: "bg-rose-500/25 text-rose-800 dark:text-rose-300",
    },
  }[banner.type || "info"];

  const Icon = typeConfig.icon;

  return (
    <div
      className={cn(
        "relative mb-4 flex items-center justify-between gap-3 overflow-hidden rounded-2xl border px-4 py-3 backdrop-blur-md transition-all shadow-soft",
        typeConfig.bg,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background/60 shadow-xs">
          <Icon className={cn("h-4 w-4", typeConfig.iconColor)} />
        </span>
        <span
          className={cn(
            "hidden sm:inline-block rounded-full px-2 py-0.5 text-[0.7rem] font-bold uppercase tracking-wider",
            typeConfig.badgeColor,
          )}
        >
          {typeConfig.badge}
        </span>
        <p className="min-w-0 truncate text-sm font-medium">{banner.message}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {banner.link && (
          <Link
            to={banner.link}
            className="flex items-center gap-1 rounded-xl bg-background/80 px-2.5 py-1 text-xs font-semibold text-foreground shadow-xs transition-colors hover:bg-background"
          >
            <span>Details</span>
            <ChevronRight className="h-3 w-3" />
          </Link>
        )}
        {banner.dismissible && (
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss banner"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
