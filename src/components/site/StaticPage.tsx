import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { appConfig } from "@/lib/config";

const NAV = [
  { to: "/about", label: "About" },
  { to: "/guidelines", label: "Guidelines" },
  { to: "/contact", label: "Contact" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
] as const;

export function StaticPage({
  eyebrow,
  title,
  intro,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Link to="/" className="text-lg font-extrabold tracking-tight">
            {appConfig.brand.name}
          </Link>
          <nav className="hidden gap-6 text-sm text-muted-foreground sm:flex">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="transition-colors hover:text-foreground"
                activeProps={{ className: "text-foreground font-semibold" }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Link
            to="/auth"
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Get started
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand">{eyebrow}</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-5 text-lg leading-relaxed text-muted-foreground">{intro}</p>
        {updated && <p className="mt-3 text-xs text-muted-foreground">Last updated {updated}</p>}
        <div className="prose-static mt-12 space-y-10">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function SiteFooter() {
  const cols = [
    {
      title: "Product",
      links: [
        { to: "/feed", label: "Feed" },
        { to: "/explore", label: "Explore" },
        { to: "/spaces", label: "Spaces" },
        { to: "/pricing", label: "Pricing" },
      ],
    },
    {
      title: "Company",
      links: [
        { to: "/about", label: "About" },
        { to: "/contact", label: "Contact" },
      ],
    },
    {
      title: "Resources",
      links: [
        { to: "/guidelines", label: "Community guidelines" },
        { to: "/contact", label: "Help & support" },
      ],
    },
    {
      title: "Legal",
      links: [
        { to: "/terms", label: "Terms of service" },
        { to: "/privacy", label: "Privacy policy" },
      ],
    },
  ] as const;
  return (
    <footer className="border-t border-border bg-card/60 pb-10 pt-16">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 grid gap-x-12 gap-y-10 md:grid-cols-6">
          <div className="md:col-span-2">
            <p className="mb-3 text-2xl font-extrabold tracking-tight">{appConfig.brand.name}</p>
            <p className="max-w-xs text-sm text-muted-foreground">{appConfig.brand.tagline}</p>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <p className="mb-4 text-xs font-bold uppercase tracking-wider text-foreground">{c.title}</p>
              <ul className="space-y-3 text-sm text-muted-foreground">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className="transition-colors hover:text-brand">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border pt-8 text-sm text-muted-foreground sm:flex-row">
          <p>
            © {new Date().getFullYear()} {appConfig.brand.name}. All rights reserved.
          </p>
          <a href={`mailto:${appConfig.brand.supportEmail}`} className="hover:text-foreground">
            {appConfig.brand.supportEmail}
          </a>
        </div>
      </div>
    </footer>
  );
}
