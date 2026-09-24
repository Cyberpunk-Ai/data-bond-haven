import { Loader2, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { appConfig } from "@/lib/config";

interface Props {
  onSelect: (place: string) => void;
  fallback: string[];
}

/** Type-ahead location search. Uses an OpenStreetMap-compatible geocoder (VITE_GEOCODER_URL). */
export function LocationField({ onSelect, fallback }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (timer.current) clearTimeout(timer.current);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `${appConfig.geocoder.url}?format=json&limit=6&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
        const json = (await res.json()) as Array<{ display_name: string }>;
        setResults(json.map((r) => r.display_name.split(",").slice(0, 3).join(",").trim()));
      } catch {
        setResults(fallback.filter((f) => f.toLowerCase().includes(q.toLowerCase())));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => ctrl.abort();
  }, [query, fallback]);

  const shown = query.trim().length < 2 ? fallback : results;

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
        {query.trim().length >= 2 && !loading && results.length === 0 && (
          <button
            type="button"
            onClick={() => onSelect(query.trim())}
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs font-semibold text-muted-foreground"
          >
            Use “{query.trim()}”
          </button>
        )}
      </div>
    </div>
  );
}
