import { createFileRoute } from "@tanstack/react-router";

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
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: About,
});

function About() {
  return (
    <StaticPage
      eyebrow="About"
      title="A home for creators and the rooms they build."
      intro={`${name} brings posts, live audio Spaces, direct messages and creator payments into one calm place — so the people you follow can talk with you, not at you.`}
    >
      <Section title="What we believe">
        <p>Conversation beats broadcast. Every feature is designed around real exchange: replies, live rooms, and private messages that stay private.</p>
        <p>Creators should get paid directly. Tips, subscriptions and payouts are built in, with transparent fees.</p>
      </Section>
      <Section title="What you can do here">
        <ul className="list-disc space-y-1 pl-5">
          <li>Share posts with photos, video, polls and locations.</li>
          <li>Host or join live audio Spaces with up to eight speakers.</li>
          <li>Message and call people you follow.</li>
          <li>Build on the platform with the developer API and webhooks.</li>
        </ul>
      </Section>
      <Section title="Get in touch">
        <p>
          Questions, partnerships or press: <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>{appConfig.brand.supportEmail}</a>.
        </p>
      </Section>
    </StaticPage>
  );
}
