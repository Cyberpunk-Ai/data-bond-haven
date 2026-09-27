import { createFileRoute, Link } from "@tanstack/react-router";

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
    <StaticPage
      eyebrow="Legal"
      title="Privacy Policy"
      intro="We collect only what we need to run the service, we never sell your personal data, and you can leave with your content whenever you want."
      updated="September 2026"
    >
      <Section title="What we collect">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Account details:</strong> email, display name,
            username, profile photo and bio — the things your profile shows.
          </li>
          <li>
            <strong className="text-foreground">Content you create:</strong> posts, comments,
            stories, direct messages, and Space recordings you choose to keep.
          </li>
          <li>
            <strong className="text-foreground">Payment records:</strong> amounts, dates,
            references and the last four digits of a payout account. Card details are handled
            by our PCI-compliant payment partners — full card numbers never touch our
            servers.
          </li>
          <li>
            <strong className="text-foreground">Technical data:</strong> device type, browser,
            approximate location from IP, and which posts you view, like or repost — used to
            run features like analytics, notifications and the feed.
          </li>
        </ul>
      </Section>

      <Section title="How we use it">
        <p>
          To operate your account, deliver messages and calls, personalise your feed, show
          creators their own analytics, prevent abuse and fraud, process payments and
          withdrawals, and send important service notices. We do not build advertising
          profiles and we do not sell your personal data to anyone.
        </p>
      </Section>

      <Section title="Direct messages and calls">
        <p>
          Private messages are shared only with the participants in the conversation. Audio in
          Spaces and calls travels directly between participants where possible. Nothing in a
          call or Space is recorded unless the host starts a recording and everyone in the
          room is notified.
        </p>
      </Section>

      <Section title="Who we share with">
        <p>
          Only the service providers who help us operate the platform — hosting, payment
          processing, email delivery and fraud prevention — each bound to use your data only
          for the job we hired them for; law enforcement when we're required by law; and
          anyone else only with your permission. Team members you add to a workspace can see
          the team's content and earnings data according to their role.
        </p>
      </Section>

      <Section title="Cookies and local storage">
        <p id="cookies">
          We use essential browser storage to keep you signed in and remember preferences
          like your theme and active team. We don't use third-party advertising cookies or
          cross-site trackers.
        </p>
      </Section>

      <Section title="How long we keep things">
        <p>
          Your content lives as long as your account does. If you delete a post or message,
          it's removed from the product right away. We keep payment records for as long as
          financial-law requirements oblige us to, in reduced form, and moderation/appeals
          records for as long as we need them to keep the platform safe.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data is encrypted in transit, access is strictly role-based, and the pieces that
          touch money are additionally guarded behind verification steps. No system is
          perfect — if you believe your account is compromised, reset your password and
          contact us immediately.
        </p>
      </Section>

      <Section title="Children">
        <p>
          {name} is not for children under 13 (or the minimum age in your country). We don't
          knowingly collect data from children, and we remove accounts that should not exist.
        </p>
      </Section>

      <Section title="Your choices">
        <ul className="list-disc space-y-1 pl-5">
          <li>Export or delete your data and account from Settings at any time.</li>
          <li>Control who can message you, reply to you and see your activity.</li>
          <li>Mute, block or report anyone; tune the feed away from topics you don't want.</li>
          <li>Turn non-essential notifications off in Settings.</li>
        </ul>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes materially we'll tell you in the product and update the
          "last updated" date above. Continued use after a change means acceptance of it.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Privacy questions:{" "}
          <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>
            {appConfig.brand.supportEmail}
          </a>
          . For anything else, see the{" "}
          <Link to="/help" className="font-semibold text-brand underline">
            Help Center
          </Link>
          .
        </p>
      </Section>
    </StaticPage>
  );
}
