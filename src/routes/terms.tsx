import { createFileRoute } from "@tanstack/react-router";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: `Terms of Service — ${name}` },
      { name: "description", content: `The rules for using ${name}.` },
      { property: "og:title", content: `Terms of Service — ${name}` },
      { property: "og:description", content: `The rules for using ${name}.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Terms,
});

function Terms() {
  return (
    <StaticPage eyebrow="Legal" title="Terms of Service" intro={`By creating an account or using ${name}, you agree to these terms.`} updated="September 2026">
      <Section title="1. Your account">
        <p>You must be at least 13 years old (or the minimum age in your country). You're responsible for activity on your account and for keeping your password safe.</p>
      </Section>
      <Section title="2. Your content">
        <p>You own what you post. You give us a licence to host, display and distribute it so the service can work. You're responsible for having the rights to anything you upload.</p>
      </Section>
      <Section title="3. Acceptable use">
        <p>Follow our Community Guidelines. No harassment, hate, illegal content, spam, impersonation, or attempts to break or overload the service.</p>
      </Section>
      <Section title="4. Payments and payouts">
        <p>Subscriptions renew until cancelled. Tips are final once sent. Platform fees are shown before you pay. Creators are responsible for their own taxes.</p>
      </Section>
      <Section title="5. Developer API">
        <p>API keys are personal and must be kept secret. We may rate-limit or revoke keys that are abused.</p>
      </Section>
      <Section title="6. Termination">
        <p>You can delete your account at any time from Settings. We may suspend accounts that break these terms.</p>
      </Section>
      <Section title="7. Liability">
        <p>The service is provided "as is". To the extent allowed by law, we aren't liable for indirect or consequential losses.</p>
      </Section>
      <Section title="8. Contact">
        <p>Questions about these terms: {appConfig.brand.supportEmail}</p>
      </Section>
    </StaticPage>
  );
}
