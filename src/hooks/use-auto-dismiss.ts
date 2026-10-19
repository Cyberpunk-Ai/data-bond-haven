import { useEffect, useRef } from "react";

/**
 * Auto-reset a piece of transient UI state (a toast, a "saved" tick, a "copied"
 * badge) a fixed time after it becomes active.
 *
 * Replaces the `setTimeout(() => setX(null), ms)` scattered through the admin
 * tabs and dialogs. Those timers were never cleared, so they kept a closure
 * alive after the component unmounted and re-armed on every action without
 * cancelling the previous one. This version owns a single timer per activation
 * and tears it down on unmount or when `active` flips back to false — the state
 * still clears on the same schedule, just without the leak or the double-fire.
 */
export function useAutoDismiss(active: boolean, reset: () => void, ms = 3500): void {
  // Keep the latest reset without making it an effect dependency, so a caller
  // passing an inline arrow never re-arms the timer on every render.
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => resetRef.current(), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
}
