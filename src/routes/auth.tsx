import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Sparkles, CheckCircle2, ArrowRight } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { setLoggedOut, useAuth } from "@/lib/auth-state";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): { email?: string } =>
    typeof search["email"] === "string" ? { email: search["email"] as string } : {},
  head: () => ({
    meta: [
      { title: "Sign In or Join — Spaces1" },
      {
        name: "description",
        content:
          "Create your Spaces1 account or sign back in to post, join live audio rooms, message creators and tip the people you follow.",
      },
      { property: "og:title", content: "Sign In or Join — Spaces1" },
      {
        property: "og:description",
        content: "Create a Spaces1 account or sign in to post, chat and go live.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function handleFrom(email: string | undefined, fallback: string) {
  const base = (email?.split("@")[0] || fallback).replace(/[^a-z0-9_]/gi, "").toLowerCase();
  return base.slice(0, 18) || "member";
}

/** Turn provider errors into something a person can act on. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password don't match an account.";
  if (m.includes("email not confirmed"))
    return "Please confirm your email first — check your inbox for the link.";
  if (m.includes("already registered") || m.includes("user already exists"))
    return "An account with this email already exists. Try signing in instead.";
  if (m.includes("password")) return "Your password must be at least 6 characters.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Please wait a minute and try again.";
  if (m.includes("unsupported provider") || m.includes("provider is not enabled"))
    return "Google sign-in isn't available right now. Use your email and password instead.";
  return message;
}

function AuthPage() {
  const navigate = useNavigate();
  const { user, isLoggedIn } = useAuth();
  const { email: prefillEmail } = Route.useSearch();

  const [mode, setMode] = useState<"signin" | "signup">(prefillEmail ? "signup" : "signin");
  const [email, setEmail] = useState(prefillEmail ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkInbox, setCheckInbox] = useState<false | "confirm" | "link">(false);

  async function handleGoogle() {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) {
        toast.error(friendlyAuthError(error.message));
        return;
      }
      return;
      toast.success("Signed in");
      void navigate({ to: "/" });
    } catch (err) {
      toast.error(err instanceof Error ? friendlyAuthError(err.message) : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) {
      toast.error("Please enter your email");
      return;
    }
    if (password.length < 6) {
      toast.error("Your password must be at least 6 characters");
      return;
    }

    setBusy(true);
    setCheckInbox(false);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: address,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: {
              display_name: displayName.trim() || handleFrom(address, "member"),
              username: handleFrom(address, "member"),
            },
          },
        });

        if (error) {
          toast.error(friendlyAuthError(error.message));
          return;
        }

        if (data.session) {
          toast.success("Account created — welcome to Spaces1!");
          void navigate({ to: "/" });
          return;
        }

        setCheckInbox("confirm");
        toast.success("Almost there — confirm your email to finish signing up.");
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: address,
        password,
      });

      if (error) {
        toast.error(friendlyAuthError(error.message));
        return;
      }

      if (data.session) {
        toast.success("Signed in");
        void navigate({ to: "/" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? friendlyAuthError(err.message) : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  /** Passwordless sign-in: emails a one-time link. */
  async function handleMagicEmail() {
    const address = email.trim();
    if (!address) {
      toast.error("Please type your email above first");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) {
        toast.error(friendlyAuthError(error.message));
        return;
      }
      setCheckInbox("link");
      toast.success("Sign-in link sent — check your inbox.");
    } catch (err) {
      toast.error(
        err instanceof Error ? friendlyAuthError(err.message) : "Could not send the link",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-3xl border border-border/80 bg-card p-6 shadow-soft transition-all">
        {/* Header */}
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-pink text-white shadow-sm">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-black tracking-tight text-foreground">
              {isLoggedIn ? "Account Active" : mode === "signin" ? "Welcome back" : "Join Spaces1"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {isLoggedIn
                ? "You are currently signed in"
                : mode === "signin"
                  ? "Sign in to post, chat & go live"
                  : "Create an account in seconds"}
            </p>
          </div>
        </div>

        {isLoggedIn && user ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/30 p-3.5">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user.display_name}
                  className="h-12 w-12 rounded-full border border-border object-cover"
                />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-pink text-sm font-black text-white">
                  {(user.display_name || user.username || "?").charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-bold text-sm text-foreground">
                    {user.display_name}
                  </span>
                  {user.verified && <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />}
                </div>
                <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
                {user.email && (
                  <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void navigate({ to: "/" })}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink py-2.5 text-sm font-bold text-white shadow-sm hover:opacity-95 active:scale-98 transition-all"
            >
              <span>Continue to Spaces1</span>
              <ArrowRight className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => {
                setLoggedOut();
                toast.success("Signed out");
              }}
              className="w-full rounded-full border border-border bg-background py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Sign out / Switch account
            </button>
          </div>
        ) : (
          <>
            {/* Mode Selector */}
            <div className="mb-5 flex rounded-2xl bg-muted/40 p-1">
              {(["signin", "signup"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setCheckInbox(false);
                  }}
                  className={cn(
                    "flex-1 rounded-xl px-3 py-1.5 text-xs font-bold transition-all cursor-pointer",
                    mode === m
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            {/* Google Sign-in */}
            <button
              type="button"
              onClick={handleGoogle}
              disabled={busy}
              className="mb-4 flex w-full items-center justify-center gap-2.5 rounded-full border border-border bg-background py-2.5 text-sm font-bold text-foreground transition-all hover:bg-accent/80 active:scale-98 disabled:opacity-60 shadow-xs cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.8z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8h-4v3.1A12 12 0 0 0 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6v-3.1h-4a12 12 0 0 0 0 10.8l4-3.1z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.4 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            <div className="mb-4 flex items-center gap-3 text-[11px] font-semibold text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              OR WITH EMAIL
              <span className="h-px flex-1 bg-border" />
            </div>

            {checkInbox && (
              <div className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                {checkInbox === "confirm" ? (
                  <>
                    We sent a confirmation link to{" "}
                    <span className="font-bold text-foreground">{email}</span>. Open it to activate
                    your account, then come back and sign in.
                  </>
                ) : (
                  <>
                    We sent a sign-in link to{" "}
                    <span className="font-bold text-foreground">{email}</span>. Open it on this
                    device to finish signing in.
                  </>
                )}
              </div>
            )}

            {/* Email + Password Form */}
            <form onSubmit={handleSubmit} className="space-y-3">
              {mode === "signup" && (
                <div>
                  <label
                    htmlFor="auth-name"
                    className="block text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-1"
                  >
                    Display Name
                  </label>
                  <input
                    id="auth-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    placeholder="Your name"
                    className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-brand placeholder:text-muted-foreground/60 border border-transparent focus:border-brand/40"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-email"
                  className="block text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-1"
                >
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-brand placeholder:text-muted-foreground/60 border border-transparent focus:border-brand/40"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="auth-password"
                    className="block text-[11px] font-bold text-muted-foreground uppercase tracking-wider"
                  >
                    Password
                  </label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={handleMagicEmail}
                      disabled={busy}
                      className="text-[11px] font-semibold text-brand hover:underline cursor-pointer disabled:opacity-60"
                    >
                      Email me a sign-in link
                    </button>
                  )}
                </div>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-brand placeholder:text-muted-foreground/60 border border-transparent focus:border-brand/40"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink py-2.5 text-sm font-bold text-white shadow-sm hover:opacity-95 active:scale-98 disabled:opacity-60 transition-all cursor-pointer"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              By continuing you agree to our community guidelines. We only email you about your
              account.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
