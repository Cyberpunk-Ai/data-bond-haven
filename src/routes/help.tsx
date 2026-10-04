import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta } from "@/lib/seo";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/help")({
  head: () => ({
    meta: [
      { title: `Help Center — ${name}` },
      {
        name: "description",
        content: `Answers to the most common questions about ${name}: accounts, posting, teams, tips, payouts and safety.`,
      },
      { property: "og:title", content: `Help Center — ${name}` },
      { property: "og:description", content: `How to get the most out of ${name}.` },
      { property: "og:type", content: "website" },
      // The site card is this page's picture, and it is 1200x630 — a `summary`
      // card would shrink that banner to a thumbnail next to the text.
      { name: "twitter:card", content: "summary_large_image" },
      ogUrlMeta("/help"),
    ],
    links: [canonicalLink("/help")],
  }),
  component: Help,
});

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-border bg-card/60 px-5 py-4 open:bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold marker:hidden">
        <span>{q}</span>
        <span className="shrink-0 text-lg leading-none text-muted-foreground transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

function Help() {
  return (
    <StaticPage
      eyebrow="Help Center"
      title="How can we help?"
      intro="Quick answers for the things people ask most. Can't find yours? Support replies within one business day."
    >
      <Section title="Getting started">
        <div className="space-y-2">
          <Faq q="Do I need an account to look around?">
            <p>
              You can read public posts and Spaces without one. An account unlocks posting,
              replying, following, messaging, tipping and your own profile.
            </p>
          </Faq>
          <Faq q="How do I make my first post?">
            <p>
              Open the Feed, tap the composer at the top, write something and hit Post. You can
              attach photos, video, polls and a location. Posts can be edited or deleted any time
              from the ••• menu on your card.
            </p>
          </Faq>
          <Faq q="What are Stories and Spaces?">
            <p>
              Stories are short posts that live at the top of the feed for 24 hours. Spaces are live
              audio rooms — join as a listener, request the mic, or host your own room.
            </p>
          </Faq>
        </div>
      </Section>

      <Section title="Posting, reposting & teams">
        <div className="space-y-2">
          <Faq q="What does Repost do?">
            <p>
              A repost puts someone else's post on your profile so your followers can see it. Tap it
              again to undo. If you belong to a team and have posting rights, reposts go out under
              the active team's name — they appear on the team's Reposts tab.
            </p>
          </Faq>
          <Faq q="How do team workspaces work?">
            <p>
              A workspace lets a group publish under one brand. The owner invites members with
              roles: Owners manage everything, Admins manage members and settings, Editors can post
              and repost, Viewers just read. Switch your composer identity between yourself and your
              teams from the feed.
            </p>
          </Faq>
          <Faq q="Who sees my direct messages?">
            <p>
              Only you and the people in the conversation. Messages are private; you control who can
              message you in Settings, and you can report or block anyone from a conversation.
            </p>
          </Faq>
        </div>
      </Section>

      <Section title="Tips, earnings & withdrawals">
        <div className="space-y-2">
          <Faq q="How do tips work?">
            <p>
              Supporters can tip any creator or team from a post, profile or chat. Tips arrive in
              your earnings balance at 100% — nothing is deducted when a tip lands.
            </p>
          </Faq>
          <Faq q="When does the platform take a fee?">
            <p>
              Only when you withdraw. Your plan sets the withdrawal fee: Free 5%, Plus 3%, Pro 1%.
              The exact fee and the amount that reaches your bank are shown before you confirm any
              withdrawal.
            </p>
          </Faq>
          <Faq q="What currency are earnings in?">
            <p>
              Balances are shown and requested in US dollars, the platform's standard. Withdrawals
              are delivered to your local bank or mobile-money account in your own currency at the
              prevailing conversion shown on screen.
            </p>
          </Faq>
          <Faq q="How long does a withdrawal take?">
            <p>
              Most complete within minutes to a few hours. If a transfer can't be completed, the
              amount is returned to your balance automatically and you can retry or fix your payout
              details.
            </p>
          </Faq>
          <Faq q="My bank isn't in the list.">
            <p>
              Type your bank's full name — the list is a shortcut, not a limit. Your account is
              verified against your bank before anything is saved, and again before money moves, so
              typos are caught early.
            </p>
          </Faq>
        </div>
      </Section>

      <Section title="Safety & moderation">
        <div className="space-y-2">
          <Faq q="How do I report something?">
            <p>
              Every post, profile, story and message has a Report option in its menu. Tell us what
              rule was broken; moderators review every report and act on the{" "}
              <Link to="/guidelines" className="font-semibold text-brand underline">
                Community Guidelines
              </Link>
              .
            </p>
          </Faq>
          <Faq q="Can I stop someone from contacting me?">
            <p>
              Yes. Blocking hides their content from you, prevents them from seeing or messaging
              you, and works from profiles, posts and conversations.
            </p>
          </Faq>
          <Faq q="What happens to my account if I break the rules?">
            <p>
              Depending on severity: a warning, temporary restriction of a feature, suspension, or
              removal for serious or repeated breaches. Suspended accounts can appeal through
              Support.
            </p>
          </Faq>
        </div>
      </Section>

      <Section title="Account & data">
        <div className="space-y-2">
          <Faq q="How do I change my plan?">
            <p>
              Pricing and plan changes live under Settings → Subscription. Upgrades apply
              immediately; downgrades take effect at the end of the current billing period. You can
              cancel any time and keep access until then.
            </p>
          </Faq>
          <Faq q="Can I delete my account?">
            <p>
              Yes — Settings takes you through it. Your posts and media are removed; some records
              (like payment ledgers required by law or our processing partners) are kept in reduced
              form. See the{" "}
              <Link to="/privacy" className="font-semibold text-brand underline">
                Privacy Policy
              </Link>
              .
            </p>
          </Faq>
          <Faq q="I'm having a billing problem.">
            <p>
              Charges should only happen for your subscription, tips you send, or fees shown before
              a withdrawal. If something looks wrong, contact{" "}
              <Link to="/contact" className="font-semibold text-brand underline">
                Support
              </Link>{" "}
              with the date and amount and we'll trace it.
            </p>
          </Faq>
        </div>
      </Section>

      <Section title="Still stuck?">
        <p>
          Email{" "}
          <a
            className="font-semibold text-brand underline"
            href={`mailto:${appConfig.brand.supportEmail}`}
          >
            {appConfig.brand.supportEmail}
          </a>{" "}
          or use the{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            contact form
          </Link>{" "}
          — we usually reply within one business day. For live service issues, check the{" "}
          <Link to="/status" className="font-semibold text-brand underline">
            Status page
          </Link>
          .
        </p>
      </Section>
    </StaticPage>
  );
}
