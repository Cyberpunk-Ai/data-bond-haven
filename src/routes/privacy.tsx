import { createFileRoute } from "@tanstack/react-router";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: `Privacy Policy — ${name}` },
      { name: "description", content: `What ${name} collects, why, and the choices you have.` },
      { property: "og:title", content: `Privacy Policy — ${name}` },
      { property: "og:description", content: `What ${name} collects, why, and the choices you have.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <StaticPage eyebrow="Legal" title="Privacy Policy" intro="We collect only what we need to run the service, and we never sell your personal data." updated="September 2026">
      <Section title="What we collect">
        <ul className="list-disc space-y-1 pl-5">
          <li>Account details: email, name, username, profile photo.</li>
          <li>Content you create: posts, messages, Space recordings you choose to keep.</li>
          <li>Payment records from our payment providers (we never see full card numbers).</li>
          <li>Basic technical data: device, browser and approximate location from your IP.</li>
        </ul>
      </Section>
      <Section title="How we use it">
        <p>To run your account, deliver messages and calls, personalise your feed, prevent abuse, process payments, and send important notices.</p>
      </Section>
      <Section title="Live audio and calls">
        <p>Audio in Spaces and calls travels directly between participants where possible. We don't record unless the host starts a recording and everyone is notified.</p>
      </Section>
      <Section title="Sharing">
        <p>We share data only with service providers who help us operate (hosting, payments, email), when required by law, or with your permission.</p>
      </Section>
      <Section title="Cookies" id="cookies">
        <p>We use essential storage to keep you signed in and remember your preferences. We don't use third-party advertising cookies.</p>
      </Section>
      <Section title="Your choices">
        <p>You can export or delete your data from Settings at any time, change who can message you, and control notifications.</p>
      </Section>
      <Section title="Contact">
        <p>Privacy questions: {appConfig.brand.supportEmail}</p>
      </Section>
    </StaticPage>
  );
}
