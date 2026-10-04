import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta } from "@/lib/seo";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: `About — ${name}` },
      { name: "description", content: `Why ${name} exists and the people it's built for.` },
      { property: "og:title", content: `About — ${name}` },
      { property: "og:description", content: `Why ${name} exists and the people it's built for.` },
      { property: "og:type", content: "website" },
      // The site card is this page's picture, and it is 1200x630 — a `summary`
      // card would shrink that banner to a thumbnail next to the text.
      { name: "twitter:card", content: "summary_large_image" },
      ogUrlMeta("/about"),
    ],
    links: [canonicalLink("/about")],
  }),
  component: About,
});

function About() {
  return (
    <StaticPage
      eyebrow="About"
      title="A home for creators and the rooms they build."
      intro={`${name} brings posts, stories, live audio Spaces, direct messages, team workspaces and creator payments into one calm place — so the people you follow can talk with you, not at you.`}
      updated="September 2026"
    >
      <Section title="What we believe">
        <p>
          <strong className="text-foreground">Conversation beats broadcast.</strong> Every feature
          is designed around real exchange: replies, live rooms, and private messages that stay
          private.
        </p>
        <p>
          <strong className="text-foreground">Creators should get paid directly.</strong> Supporters
          tip without middlemen deciding who deserves an audience. We keep the platform's cut small
          and honest: nothing is taken when a tip arrives — a single withdrawal fee (5% on Free, 3%
          on Plus, 1% on Pro) applies only when a creator cashes out, and it's always shown before
          they confirm.
        </p>
        <p>
          <strong className="text-foreground">Your data is yours.</strong> We don't sell personal
          information and we don't run a surveillance advertising model. The service is funded by
          subscriptions, not by your attention being auctioned.
        </p>
      </Section>

      <Section title="What you can do here">
        <ul className="list-disc space-y-2 pl-5">
          <li>Share posts with photos, video, polls, stories and locations.</li>
          <li>Host or join live audio Spaces with your community.</li>
          <li>Message and call people you follow — privately.</li>
          <li>
            Build with a team: workspace profiles with roles, shared posting, team tips and team
            analytics.
          </li>
          <li>
            Earn from your work: tips in USD, transparent withdrawals to local banks and mobile
            money, worldwide.
          </li>
          <li>Understand your audience with real analytics computed from your own posts.</li>
          <li>Build on the platform with the developer API and webhooks.</li>
        </ul>
      </Section>

      <Section title="Who it's for">
        <p>
          Creators who want a direct relationship with their audience — writers, musicians,
          educators, podcasters, devs, small studios and community teams — and the people who
          support them. The platform is global by default: balances in dollars, payouts to local
          currencies, and content in your own language.
        </p>
      </Section>

      <Section title="The essentials">
        <p>
          Plans and fees are published on the{" "}
          <Link to="/pricing" className="font-semibold text-brand underline">
            pricing page
          </Link>
          . The rules that keep things healthy are in the{" "}
          <Link to="/guidelines" className="font-semibold text-brand underline">
            Community Guidelines
          </Link>
          , and the fine print lives in the{" "}
          <Link to="/terms" className="font-semibold text-brand underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link to="/privacy" className="font-semibold text-brand underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Get in touch">
        <p>
          Questions, partnerships or press:{" "}
          <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>
            {appConfig.brand.supportEmail}
          </a>
          , or use the{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            contact form
          </Link>
          .
        </p>
      </Section>
    </StaticPage>
  );
}
