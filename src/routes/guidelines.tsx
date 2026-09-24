import { createFileRoute } from "@tanstack/react-router";

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
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Guidelines,
});

function Guidelines() {
  return (
    <StaticPage eyebrow="Community" title="Community Guidelines" intro="Be the kind of person you'd want in the room.">
      <Section title="Respect people">
        <p>No harassment, threats, hate speech or targeting people for who they are.</p>
      </Section>
      <Section title="Be real">
        <p>Don't impersonate others, run fake accounts or mislead people about who you are.</p>
      </Section>
      <Section title="Keep it safe">
        <p>No sexual content involving minors, no promotion of violence or self-harm, and nothing illegal.</p>
      </Section>
      <Section title="No spam">
        <p>Don't flood feeds, messages or Spaces with repetitive or unwanted content.</p>
      </Section>
      <Section title="Reporting">
        <p>Use "Report" on any post, profile or message. Our moderators review every report.</p>
      </Section>
    </StaticPage>
  );
}
