import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";
import { reportError } from "../lib/error-reporting";
import { bootstrapTheme, themeColorFor } from "../lib/theme-state";
import { appConfig } from "../lib/config";
import { OG_IMAGE_META } from "../lib/og-meta";
import { ICON_LINKS } from "../lib/seo";
import { supabase } from "@/integrations/supabase/client";
import { IncomingCallProvider } from "@/components/calls/IncomingCallProvider";

/**
 * The fallback document title and description, from the one brand name the
 * deployment configures (`VITE_APP_NAME`, see src/lib/config.ts). Indexable
 * routes override both; this is what a page with no head of its own, a
 * bookmark, or a home-screen shortcut shows.
 */
const BRAND = appConfig.brand.name;
const ROOT_TITLE = `${BRAND} — Live Audio Spaces, Stories & Messaging`;
const ROOT_DESCRIPTION = `${BRAND} brings people together to discover, explore, build and share — live audio spaces, stories, messaging, tips and payouts in one place.`;

function NotFoundComponent() {
  const links = [
    { to: "/feed", label: "Your feed" },
    { to: "/explore", label: "Explore" },
    { to: "/spaces", label: "Live Spaces" },
    { to: "/contact", label: "Get help" },
  ] as const;
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <span className="select-none text-[38vw] font-black leading-none tracking-tighter text-foreground/[0.04]">
          404
        </span>
      </div>
      <div className="relative max-w-md text-center">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-brand">Lost in space</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">
          This page drifted off.
        </h1>
        <p className="mt-4 text-muted-foreground">
          The link may be broken, or the page may have been removed. Try one of these instead.
        </p>
        <div className="mt-8 grid grid-cols-2 gap-2">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="rounded-xl border border-border bg-card px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:border-brand/50"
            >
              {l.label}
            </Link>
          ))}
        </div>
        <Link
          to="/"
          className="mt-6 inline-flex rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: ROOT_TITLE },
      {
        name: "description",
        content: ROOT_DESCRIPTION,
      },
      { property: "og:title", content: ROOT_TITLE },
      {
        property: "og:description",
        content: appConfig.brand.tagline,
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: BRAND },
      { property: "og:locale", content: "en_US" },
      // The site's own 1200x630 preview card, merged into every route's head.
      // Pages with a picture of their own (a profile avatar, a post's photo)
      // override it with `pagePreviewMeta`, which is why this is a spread and
      // not a constant.
      ...OG_IMAGE_META,
      { name: "twitter:card", content: "summary_large_image" },
      // Paints the browser's address bar and the installed-app title bar. The
      // hex is derived from the same oklch brand token the stylesheet uses, and
      // `applyThemeToDOM` re-points it when someone picks another accent.
      { name: "theme-color", content: themeColorFor() },
      // iOS reads these instead of the manifest: without a title here (and an
      // `id`/`name` in the manifest) a home-screen shortcut lands as an
      // untitled blank web app, which PWA audits score as "no touch web app
      // title declared".
      { name: "apple-mobile-web-app-title", content: BRAND },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      // Deliberately no `robots` meta here: the root head is merged into every
      // route, and a blanket `index,follow` would compete with the
      // `noindex,nofollow` that private routes declare for themselves.
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
      },
      // Sized icon set (svg + 16/32/48/192/256/512 png + ico + apple-touch +
      // manifest) — see ICON_LINKS for the reading order and why each lives.
      ...ICON_LINKS,
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    bootstrapTheme();
  }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <IncomingCallProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        <Toaster position="top-right" richColors />
      </IncomingCallProvider>
    </QueryClientProvider>
  );
}
