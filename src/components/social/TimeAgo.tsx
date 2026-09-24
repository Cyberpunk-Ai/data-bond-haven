import { useEffect, useState } from "react";
import { SEED_ANCHOR, timeAgo } from "@/lib/formatters";

/**
 * Returns the hour-rounded seed anchor during SSR and the first client render
 * (so markup matches and hydration stays clean), then switches to real wall
 * clock time and keeps ticking once a minute.
 */
export function useLiveNow() {
  const [now, setNow] = useState<number>(SEED_ANCHOR);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return now;
}

export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  const now = useLiveNow();
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()} className={className}>
      {timeAgo(iso, now)}
    </time>
  );
}
