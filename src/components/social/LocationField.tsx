import { Loader2, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { locationSearch } from "@/lib/geo.functions";

interface Props {
  onSelect: (place: string) => void;
  fallback: string[];
}

/**
 * Type-ahead location search. The lookup runs on our own server
 * (`lib/geo.functions.ts`), which forwards it to the configured geocoder — a
 * browser call to a third-party host would be refused by the CSP's `connect-src`
 * allowlist, and OpenStreetMap wants an identifying User-Agent a page cannot
 * set. Failures are shown as such, never dressed up as "no matches".
 */
export function LocationField({ onSelect, fallback }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An answer that lands after the user kept typing belongs to a query that no
  // longer exists, so tag every request and drop anything stale.
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const id = ++requestId.current;
    if (timer.current) clearTimeout(timer.current);
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      setUnavailable(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const answer = await locationSearch({ data: { query: q } });
        if (id !== requestId.current) return;
        setResults(answer.places);
        setUnavailable(answer.degraded);
      } catch {
        // Rate-limited, offline, or the server refused: presets plus free text
        // still work, and the note below says why the list is not real results.
        if (id !== requestId.current) return;
        setResults([]);
        setUnavailable(true);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const q = query.trim();
  const presetMatches = fallback.filter((f) => f.toLowerCase().includes(q.toLowerCase()));
  const shown = q.length < 2 ? fallback : results.length > 0 ? results : presetMatches;

  return (
    <div className="mt-2 rounded-2xl border border-border/80 bg-foreground/5 p-3 animate-in fade-in">
      <label htmlFor="composer-location" className="mb-1.5 block text-xs font-bold text-foreground">
        Location
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3">
        <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          id="composer-location"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) {
              e.preventDefault();
              onSelect(results[0] ?? query.trim());
            }
          }}
          placeholder="Search a city, venue or address"
          className="flex-1 bg-transparent py-2 text-xs outline-none"
          maxLength={120}
        />
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {shown.map((loc) => (
          <button
            key={loc}
            type="button"
            onClick={() => onSelect(loc)}
            className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold transition-all hover:border-brand/40 active:scale-95"
          >
            {loc}
          </button>
        ))}
        {q.length >= 2 && !loading && results.length === 0 && (
          <button
            type="button"
            onClick={() => onSelect(q)}
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs font-semibold text-muted-foreground"
          >
            Use “{q}”
          </button>
        )}
      </div>
      {unavailable && q.length >= 2 && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Location search is not answering right now, so this is the preset list. Your place name is
          stored exactly as you type it.
        </p>
      )}
    </div>
  );
}
