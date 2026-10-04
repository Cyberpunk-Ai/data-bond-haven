import { AlertTriangle, Construction, ShieldCheck } from "lucide-react";

import { usePlatform } from "@/lib/platform-state";
import { appConfig } from "@/lib/config";

/**
 * The visible half of Maintenance Mode. Enforcement is elsewhere (the database
 * guards refuse visitor writes, the auth middleware refuses server actions);
 * this exists so the restricted person understands why, instead of collecting
 * error toasts. Staff see a different copy — for them the switch is a state
 * they are responsible for, not a lock on their own account.
 */
export function MaintenanceBanner() {
  const { maintenanceActive, maintenanceBlocked, isStaff } = usePlatform();

  if (!maintenanceActive) return null;

  if (isStaff) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs font-semibold text-amber-900 shadow-soft dark:text-amber-200">
        <ShieldCheck className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          Maintenance mode is on. Non-staff accounts can browse but cannot post, message, tip or
          start Spaces — your access stays full so you can finish the work.
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-rose-500/40 bg-gradient-to-r from-rose-500/15 via-red-500/10 to-pink-500/15 px-4 py-3 text-sm shadow-soft">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background/60 shadow-xs">
        <Construction className="h-4 w-4 text-rose-600 dark:text-rose-400" />
      </span>
      <div>
        <p className="font-bold text-rose-900 dark:text-rose-100">
          {appConfig.brand.name} is under maintenance
        </p>
        <p className="mt-0.5 text-xs text-rose-900/80 dark:text-rose-100/80">
          You can keep reading, but posting, messaging, Spaces and payments are paused for a short
          while. Nothing you have already saved is affected — try again once the banner disappears.
        </p>
      </div>
      {maintenanceBlocked && (
        <AlertTriangle className="hidden h-4 w-4 shrink-0 self-center text-rose-500 sm:block" />
      )}
    </div>
  );
}
