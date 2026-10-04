import { createFileRoute } from "@tanstack/react-router";

import { STATIC_SITEMAP_PAGES, buildSitemapXml, type SitemapEntry } from "@/lib/seo";

/**
 * `GET /sitemap.xml`
 *
 * Generated on request rather than committed as a static file, because the
 * valuable half of this sitemap is user content: `/u/<handle>` and
 * `/post/<id>` are the pages that bring in search traffic, and a file checked
 * into `public/` would freeze them on the day it was written.
 *
 * Reads go through the service-role client, which bypasses RLS — so the
 * visibility predicate is written out here and must keep matching the policies
 * in `20260924000002_starpace_grants_and_rls.sql`: `posts public read` is
 * `not hidden`, and a suspended account (`profiles.status`) is not a page worth
 * advertising. Publishing a URL that then renders "unavailable" is precisely the
 * soft-404 that gets a sitemap distrusted.
 *
 * Caps: 5,000 profiles and 20,000 posts, newest first. Past that the right move
 * is a sitemap index with one child file per slice — not a longer single file,
 * which Google truncates at 50,000 URLs without telling you.
 */

const PROFILE_LIMIT = 5_000;
const POST_LIMIT = 20_000;

/** Rows the sitemap needs, and nothing else — never `select *` on a public endpoint. */
interface PostRow {
  id: string;
  created_at: string;
}
interface ProfileRow {
  username: string;
  updated_at: string;
}

async function collectEntries(): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [...STATIC_SITEMAP_PAGES];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as unknown as {
      from(table: "posts" | "profiles"): {
        select: (columns: string) => {
          eq: (
            column: string,
            value: unknown,
          ) => {
            order: (
              column: string,
              options?: { ascending?: boolean },
            ) => {
              limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
    };

    const [posts, profiles] = await Promise.all([
      db
        .from("posts")
        .select("id, created_at")
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(POST_LIMIT),
      db
        .from("profiles")
        .select("username, updated_at")
        .eq("status", "active")
        .order("followers", { ascending: false })
        .limit(PROFILE_LIMIT),
    ]);

    for (const row of (posts.data as PostRow[] | null) ?? []) {
      if (!row?.id) continue;
      entries.push({ path: `/post/${row.id}`, lastmod: row.created_at, changefreq: "monthly" });
    }
    for (const row of (profiles.data as ProfileRow[] | null) ?? []) {
      if (!row?.username) continue;
      entries.push({
        path: `/u/${encodeURIComponent(row.username)}`,
        lastmod: row.updated_at,
        changefreq: "weekly",
      });
    }
    // A query that answered with an error still produced a usable (static-only)
    // sitemap below; say so loudly in the log instead of shipping a silently
    // shrunken file, which reads to an operator as "Google stopped crawling us".
    if (posts.error || profiles.error) {
      console.warn(
        "[sitemap] partial listing:",
        posts.error?.message ?? "",
        profiles.error?.message ?? "",
      );
    }
  } catch (err) {
    console.warn("[sitemap] could not list user pages; serving static routes only:", err);
  }
  return entries;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const xml = buildSitemapXml(await collectEntries());
        return new Response(xml, {
          status: 200,
          headers: {
            "content-type": "application/xml; charset=utf-8",
            // Public and safe to cache; an hour at the edge, a day for shared
            // caches, so a crawl storm never turns into 20,000 database reads.
            "cache-control": "public, max-age=3600, s-maxage=86400",
          },
        });
      },
    },
  },
});
