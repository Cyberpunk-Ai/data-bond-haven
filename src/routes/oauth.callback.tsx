import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { NOINDEX_META, ORG_NAME, brandedTitle } from "@/lib/seo";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/oauth/callback")({
  head: () => ({
    meta: [
      { title: brandedTitle("Signing you in") },
      { name: "description", content: `Completing your sign-in to ${ORG_NAME}.` },
      // One-shot redirect holding an auth code in the query string.
      ...NOINDEX_META,
    ],
  }),
  component: OAuthCallback,
});

/**
 * First-party auth landing for spaces1.com.
 *
 * Every OAuth / magic-link / signup-confirmation flow redirects here (rather
 * than the raw site root) so the URL operators register as an Authorized /
 * Additional redirect is a branded `https://spaces1.com/oauth/callback` on the
 * app's own origin — not a Supabase-hosted endpoint. supabase-js still performs
 * the PKCE code exchange via `detectSessionInUrl` on client init; this route
 * simply waits for that session and then routes the user onward.
 */
function OAuthCallback() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Finishing your sign-in…");

  useEffect(() => {
    // A provider error bounces back here with these params present.
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const oauthError =
      params.get("error_description") ||
      params.get("error") ||
      hashParams.get("error_description") ||
      hashParams.get("error");
    if (oauthError) {
      setMessage("We couldn't complete that sign-in. Please try again.");
      const t = setTimeout(() => navigate({ to: "/auth", replace: true }), 2500);
      return () => clearTimeout(t);
    }

    let done = false;
    const finish = (to: "/feed" | "/auth") => {
      if (done) return;
      done = true;
      navigate({ to, replace: true });
    };

    // The exchange may already have completed by the time this mounts.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) finish("/feed");
    });

    // Otherwise wait for the auth event that URL detection fires.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) finish("/feed");
    });

    // Safety net: if nothing resolves, return the user to sign-in rather than
    // stranding them on a spinner.
    const timeout = setTimeout(() => finish("/auth"), 8000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [navigate]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <Loader2 className="h-9 w-9 animate-spin text-brand" />
        <p className="text-sm font-semibold text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
