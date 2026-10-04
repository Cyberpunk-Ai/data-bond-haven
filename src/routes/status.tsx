import { createFileRoute, Link } from "@tanstack/react-router";
import { NOINDEX_META } from "@/lib/seo";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, RotateCw } from "lucide-react";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

const name = appConfig.brand.name;

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: `System Status — ${name}` },
      {
        name: "description",
        content: `Live availability of ${name} posts, media, messages, tips and withdrawals.`,
      },
      { property: "og:title", content: `System Status — ${name}` },
      { property: "og:description", content: `Live service availability for ${name}.` },
      { property: "og:type", content: "website" },
      // NOINDEX anyway, but keep the card honest for a link someone pastes.
      { name: "twitter:card", content: "summary_large_image" },
      ...NOINDEX_META,
    ],
  }),
  component: StatusPage,
});

interface ServiceRow {
  id: string;
  label: string;
  status: "operational" | "degraded";
}

interface HealthPayload {
  status: "operational" | "degraded";
  checked_at: string;
  services: ServiceRow[];
}

const REFRESH_MS = 60_000;

function StatusPage() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/public/health", {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      const body = (await res.json()) as HealthPayload;
      if (!body || !Array.isArray(body.services)) throw new Error("bad payload");
      setHealth(body);
      setUnreachable(false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setUnreachable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [check]);

  const allOk = !unreachable && health?.status === "operational";

  return (
    <StaticPage
      eyebrow="Status"
      title="Service Status"
      intro={`Live availability of ${name}. This page checks the core services every minute and shows what's working right now.`}
    >
      <Section title="Right now">
        <div
          className={cn(
            "flex items-center gap-3 rounded-2xl border p-5",
            allOk
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-amber-500/30 bg-amber-500/10",
          )}
        >
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : allOk ? (
            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div>
            <p className="text-sm font-extrabold">
              {loading
                ? "Checking services…"
                : unreachable
                  ? "We can't reach the status service"
                  : allOk
                    ? "All systems operational"
                    : "Some services are degraded"}
            </p>
            <p className="text-xs text-muted-foreground">
              {health
                ? `Last checked ${new Date(health.checked_at).toLocaleTimeString()}`
                : "Automatically rechecks every minute."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void check();
            }}
            className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold transition-colors hover:bg-muted cursor-pointer"
          >
            <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Re-check
          </button>
        </div>

        <ul className="mt-4 divide-y divide-border rounded-2xl border border-border bg-card">
          {(
            health?.services ?? [
              { id: "app", label: "App & API", status: "operational" as const },
              { id: "data", label: "Posts, profiles & messages", status: "operational" as const },
              { id: "media", label: "Photos, video & audio", status: "operational" as const },
              { id: "payments", label: "Tips & withdrawals", status: "operational" as const },
            ]
          ).map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="text-sm font-semibold">{s.label}</span>
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide",
                  unreachable
                    ? "bg-muted text-muted-foreground"
                    : s.status === "operational"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                {!unreachable &&
                  (s.status === "operational" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ))}
                {unreachable ? "checking" : s.status === "operational" ? "operational" : "degraded"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="If something is wrong">
        <p>
          Most issues resolve themselves within minutes. If a feature keeps failing — posting,
          uploading, joining a Space, sending a tip or withdrawing earnings — please{" "}
          <Link to="/help" className="font-semibold text-brand underline">
            check the Help Center
          </Link>{" "}
          and then{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            tell us what happened
          </Link>
          . Include the time, what you were doing and any message you saw; it makes fixing things
          much faster.
        </p>
        <p>
          Payments in flight are never lost: withdrawals that don't complete are automatically
          returned to your balance.
        </p>
      </Section>

      <Section title="How this works">
        <p>
          The checks above measure whether each core service responds. Planned maintenance and
          broader incident updates are sent to affected creators through the app.
        </p>
      </Section>
    </StaticPage>
  );
}
