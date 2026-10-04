import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { DefaultRail } from "@/components/social/RightRail";
import { getSharedProfile } from "@/lib/share.functions";
import { pagePreviewMeta, previewCardFor } from "@/lib/og-meta";
import {
  NOINDEX_META,
  ORG_NAME,
  breadcrumbJsonLd,
  brandedTitle,
  canonicalLink,
  jsonLdBlock,
  ogUrlMeta,
  profileJsonLd,
} from "@/lib/seo";

export const Route = createFileRoute("/u/$username")({
  // `.catch` keeps a failed intent-preload from surfacing as an unhandled
  // rejection; a null loaderData renders the "unavailable" head/body below.
  loader: ({ params }) =>
    getSharedProfile({ data: { username: params.username } }).catch(() => null),
  head: ({ loaderData }) => {
    if (!loaderData) {
      // Unknown or renamed handle: this is the site's soft-404 guard. The page is
      // `noindex` so a dead link in the sitemap can never become a ranked page,
      // and it stays a real 200 because the body still offers a way forward.
      return {
        meta: [{ title: brandedTitle("Profile unavailable") }, ...NOINDEX_META],
      };
    }
    const title = `${loaderData.displayName} (@${loaderData.username}) — ${ORG_NAME}`;
    const description =
      loaderData.bio ||
      `Follow @${loaderData.username} on ${ORG_NAME} for posts and live audio rooms.`;
    // This URL is the crawlable profile: it is what the sitemap advertises, it
    // server-renders the real name/bio, and visitors are handed to the app view
    // from here. So it canonicalises to itself, not to `/profile?user=…`.
    const path = `/u/${encodeURIComponent(loaderData.username)}`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "profile" },
        { name: "twitter:card", content: previewCardFor(loaderData.avatarUrl) },
        // A person's face is the preview: shared profile links should show the
        // avatar, and only fall back to the site card when there isn't one (or
        // when the stored value is a private object a crawler can't fetch).
        ...pagePreviewMeta(loaderData.avatarUrl, `${loaderData.displayName}'s profile picture`),
        ogUrlMeta(path),
        // Person + the trail that got here, as one json block (see `jsonLdBlock`
        // for why this is a meta entry and not a `headScripts` key).
        jsonLdBlock(
          profileJsonLd({
            username: loaderData.username,
            displayName: loaderData.displayName,
            bio: loaderData.bio,
            avatarUrl: loaderData.avatarUrl,
            followers: loaderData.followers,
          }),
          breadcrumbJsonLd([
            { name: ORG_NAME, path: "/" },
            { name: loaderData.displayName, path },
          ]),
        ),
      ],
      links: [canonicalLink(path)],
    };
  },
  component: PublicProfilePage,
  // Same quiet hand-off state while the share loader round-trips.
  pendingComponent: ProfileHandoff,
});

/**
 * `/u/<username>` exists for link previews: crawlers read the SSR meta tags
 * above and stop there. Real visitors are only ever passing through to the
 * full profile, so the page shows a spinner instead of the old teaser card
 * (avatar, follower count, post snippets and a button asking them to continue
 * manually) that used to flash before the redirect landed.
 */
function ProfileHandoff() {
  return (
    <AppShell title="Profile" right={<DefaultRail />}>
      <div className="mx-auto flex w-full max-w-2xl items-center justify-center gap-2 rounded-3xl border border-border bg-card py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening profile…
      </div>
    </AppShell>
  );
}

function PublicProfilePage() {
  const profile = Route.useLoaderData();
  const navigate = useNavigate();

  // Copied profile links are /u/<username>. Forward visitors straight to the
  // full profile (replace, so Back doesn't loop into this hand-off page);
  // effects never run on the server, so link previews keep the meta shell.
  useEffect(() => {
    if (profile) {
      void navigate({ to: "/profile", search: { user: profile.username }, replace: true });
    }
  }, [profile, navigate]);

  if (!profile) {
    return (
      <AppShell title="Profile" right={<DefaultRail />}>
        <div className="mx-auto w-full max-w-2xl">
          <Panel className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-lg font-bold">We couldn't find that account</p>
            <p className="text-sm text-muted-foreground">The username may have changed.</p>
            <Link
              to="/explore"
              className="mt-1 inline-flex rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-sm font-bold text-white"
            >
              Explore profiles
            </Link>
          </Panel>
        </div>
      </AppShell>
    );
  }

  return <ProfileHandoff />;
}
