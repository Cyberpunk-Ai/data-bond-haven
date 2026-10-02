/**
 * Feed materializer — the background half of the "For you" redesign.
 *
 * Ranking 2,000 candidates per viewer is CPU + bandwidth work that must NEVER
 * run inside a request (that is what blew the 9s budget and starved the shared
 * node event loop). This module runs the exact same pipeline (lib/feed-rank-core)
 * ahead of the request, on a timer, and writes each viewer's ranked list into
 * `timeline_items` so the serve path is a plain indexed read.
 *
 * It is deliberately in-process (production is one always-on node server): the
 * queue lives in Postgres (`feed_rank_jobs`, fed by the post fan-out trigger and
 * by feed reads), so a restart resumes from real work and there is no second
 * service to operate. The admin (service-role) client is used because the job
 * belongs to the viewer but there is no viewer token on a timer.
 *
 * Safety valves: one timer per process, one tick at a time, a hard cap on
 * viewers rebuilt per tick, and a setImmediate yield between viewers so the
 * loop is handed back to HTTP serving and HTML never starves behind ranking.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RANK_EPOCH_MS, rankForYou } from "@/lib/feed-rank-core";

const TICK_MS = 20_000; // rebuild cadence
const VIEWERS_PER_TICK = 10; // hard cap on ranking work per tick
const TIMELINE_STORE_MAX = 300; // rows kept per viewer
const PAGE = 30; // ranker page size (drives the seen-3 replay decision only)
const BACKOFF_MS = 5 * 60_000; // re-enqueue a failed viewer later, not next tick

let started = false;
let ticking = false;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Atomically (single process, guarded tick) claim the next batch of due jobs. */
async function claimDueJobs(supabase: any): Promise<string[]> {
  const { data: due, error } = await supabase
    .from("feed_rank_jobs")
    .select("viewer_id")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(VIEWERS_PER_TICK);
  if (error || !due?.length) return [];

  const ids = (due as any[]).map((r) => r.viewer_id).filter(Boolean) as string[];
  // Delete to claim: if the rebuild fails we re-enqueue with backoff, and a
  // concurrent reader's own enqueue re-adds it, so nothing is permanently lost.
  await supabase.from("feed_rank_jobs").delete().in("viewer_id", ids);
  return ids;
}

/** Replace one viewer's materialized timeline with the freshly-ranked list. */
async function writeTimeline(
  supabase: any,
  viewerId: string,
  entries: Array<{ row: any; score: number }>,
): Promise<void> {
  const epochBucket = Math.floor(Date.now() / RANK_EPOCH_MS);
  await supabase
    .from("timeline_items")
    .delete()
    .eq("viewer_id", viewerId)
    .eq("kind", "foryou");

  const top = entries.slice(0, TIMELINE_STORE_MAX);
  if (top.length === 0) return;
  const rows = top.map((e) => ({
    viewer_id: viewerId,
    kind: "foryou",
    post_id: e.row.id,
    author_id: e.row.user_id,
    score: e.score,
    epoch: epochBucket,
    created_at: new Date(e.row.created_at).toISOString(),
  }));
  const { error } = await supabase.from("timeline_items").insert(rows);
  if (error) throw error;
}

async function rebuildViewer(supabase: any, viewerId: string): Promise<void> {
  // SECURITY INVOKER RPCs see this viewer's data keyed by id, so an admin token
  // returns the same signals the viewer's own cold-path request would.
  const { entries, personalised } = await rankForYou(supabase, viewerId, {
    refresh: false,
    limit: PAGE,
  });
  // A brand-new / unpersonalized viewer has nothing worth materializing yet;
  // their first read ranks inline (recency) and the trigger/epoch sweep will
  // build a real timeline once they have signals.
  if (personalised) await writeTimeline(supabase, viewerId, entries);
}

async function tick(): Promise<void> {
  if (ticking) return; // never overlap ticks on the single event loop
  ticking = true;
  const supabase = supabaseAdmin as any;
  try {
    const ids = await claimDueJobs(supabase);
    for (const viewerId of ids) {
      try {
        await rebuildViewer(supabase, viewerId);
      } catch (err) {
        console.warn(`feed worker: rebuild failed for ${viewerId}:`, err);
        try {
          await supabase
            .from("feed_rank_jobs")
            .upsert(
              {
                viewer_id: viewerId,
                reason: "retry",
                due_at: new Date(Date.now() + BACKOFF_MS).toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "viewer_id" },
            );
        } catch {
          /* give up; the viewer re-enqueues on their next feed read */
        }
      }
      // Hand the loop back so HTML/JS serving is never queued behind ranking.
      await yieldToEventLoop();
    }
  } catch (err) {
    console.warn("feed worker tick failed:", err);
  } finally {
    ticking = false;
  }
}

/**
 * Start the materializer timer. Called once from the server entry. Guarded so
 * hot module reloads or multiple imports never stack timers, and unref()'d so
 * the interval can't keep the process alive on its own (clean shutdown).
 */
export function startFeedWorker(): void {
  if (started || typeof setInterval === "undefined") return;
  started = true;
  const handle = setInterval(() => {
    void tick();
  }, TICK_MS);
  handle.unref?.();
  // Kick once shortly after boot so the first epoch isn't a full tick away.
  const boot = setTimeout(() => void tick(), 3_000);
  boot.unref?.();
}
