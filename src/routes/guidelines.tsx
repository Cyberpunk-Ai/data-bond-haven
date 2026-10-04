import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta } from "@/lib/seo";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/guidelines")({
  head: () => ({
    meta: [
      { title: `Community Guidelines — ${name}` },
      { name: "description", content: `How we keep ${name} a good place to talk.` },
      { property: "og:title", content: `Community Guidelines — ${name}` },
      { property: "og:description", content: `How we keep ${name} a good place to talk.` },
      { property: "og:type", content: "website" },
      // The site card is this page's picture, and it is 1200x630 — a `summary`
      // card would shrink that banner to a thumbnail next to the text.
      { name: "twitter:card", content: "summary_large_image" },
      ogUrlMeta("/guidelines"),
    ],
    links: [canonicalLink("/guidelines")],
  }),
  component: Guidelines,
});

function Guidelines() {
  return (
    <StaticPage
      eyebrow="Community"
      title="Community Guidelines"
      intro="Be the kind of person you'd want in the room. These guidelines apply to posts, replies, stories, direct messages, Spaces and team workspaces — and they're what our moderators enforce."
      updated="September 2026"
    >
      <Section title="Respect people">
        <p>
          No harassment, threats, hate speech, or targeting people for who they are — their
          identity, beliefs, or background. Disagreement is welcome; cruelty isn't. Don't pile on:
          encouraging others to attack someone is a breach even if your own words stay clean.
        </p>
      </Section>

      <Section title="Keep it safe">
        <p>
          Zero tolerance for sexual content involving minors, promotion of violence, or organising
          harm. Don't share private information about other people (doxxing) or intimate media you
          don't have the right to share. Sensitive content belongs behind your own post, not other
          people's timelines.
        </p>
      </Section>

      <Section title="Be real">
        <p>
          Don't impersonate other people, brands or teams. Don't run fake accounts or mislead people
          about who you are. Paid engagement, bot activity, repost/like manipulation and
          engagement-pod schemes undermine the whole platform and get removed. If something is
          sponsored or promotional, say so.
        </p>
      </Section>

      <Section title="No spam">
        <p>
          Don't flood feeds, replies, messages or Spaces with repetitive or unwanted content. One
          useful post reaches further than fifty identical ones.
        </p>
      </Section>

      <Section title="Live Spaces and calls">
        <p>
          Space hosts are responsible for their room: mute or remove people who break these rules,
          and remember that recordings need everyone in the room to be notified. Don't record calls
          without consent.
        </p>
      </Section>

      <Section title="Teams and workspaces">
        <p>
          Team posts carry the team's name, so the team is accountable for them. Don't create a
          workspace to dodge an individual restriction, and don't post as the team without the
          rights to — Owners and Admins manage who speaks for the group.
        </p>
      </Section>

      <Section title="Tips and money">
        <p>
          Don't use tips to harass, bait, or launder. Creators shouldn't pressure supporters into
          tips, and any "tip for X" promise should be honest. Withdrawals go only to accounts that
          belong to you or your team.
        </p>
      </Section>

      <Section title="Reporting and enforcement">
        <p>
          Use <strong className="text-foreground">Report</strong> on any post, profile, story, Space
          or message. Every report is reviewed by a human moderator. Consequences scale with
          severity and history: a warning, content removal, feature limits, suspension, or removal
          for serious or repeated breaches.
        </p>
        <p>
          Think a decision was wrong? Appeal through{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            Support
          </Link>{" "}
          — appeals are read by someone who wasn't on the original call.
        </p>
      </Section>

      <Section title="The short version">
        <p>
          Post like a person, argue like one, pay like one, and leave the platform better than you
          found it. Full details of how the service works are in our{" "}
          <Link to="/terms" className="font-semibold text-brand underline">
            Terms
          </Link>
          . Questions? The{" "}
          <Link to="/help" className="font-semibold text-brand underline">
            Help Center
          </Link>{" "}
          and {appConfig.brand.supportEmail} are open.
        </p>
      </Section>
    </StaticPage>
  );
}
