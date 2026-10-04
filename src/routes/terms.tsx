import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta } from "@/lib/seo";

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
      // The site card is this page's picture, and it is 1200x630 — a `summary`
      // card would shrink that banner to a thumbnail next to the text.
      { name: "twitter:card", content: "summary_large_image" },
      ogUrlMeta("/terms"),
    ],
    links: [canonicalLink("/terms")],
  }),
  component: Terms,
});

function Terms() {
  return (
    <StaticPage
      eyebrow="Legal"
      title="Terms of Service"
      intro={`${name} is a social network for creators and communities: you publish posts, stories and photos, host or join live audio rooms, message and call people, run a team workspace, and tip or get paid. By creating an account or using ${name}, you agree to these terms. They're written to be readable; where something affects your money, we say it plainly.`}
      updated="30 September 2026"
    >
      <Section title="1. Your account">
        <p>
          You must be at least 13 years old (or the minimum age in your country) and provide a
          working email. You're responsible for activity on your account and for keeping your
          password safe. One person, one account — platform accounts run by teams should use a
          workspace.
        </p>
        <p>
          If you sign in with Google or another provider, that provider's own terms apply to the
          sign-in step as well, and you can disconnect it at any time. The account you create here
          is yours: you can ask us to close it whenever you like, as section 8 and the{" "}
          <Link to="/privacy" className="font-semibold text-brand underline">
            Privacy Policy
          </Link>{" "}
          describe.
        </p>
      </Section>

      <Section title="2. Your content">
        <p>
          You own what you post. You give us a licence to host, display and distribute it solely so
          the service can work — showing your posts to followers, powering search and the feed, and
          (if you use them) AI drafting tools on your behalf. You're responsible for having the
          rights to anything you upload. Deleting a post removes it from the product, and the
          uploaded media with it.
        </p>
        <p>
          Public posts are visible to other people, including logged-out visitors, and can be shared
          onward by them within the rules. Please don't post other people's private information —
          theirs as well as yours. How we handle personal data, including takedown and privacy
          requests, is described in the{" "}
          <Link to="/privacy" className="font-semibold text-brand underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section title="3. Acceptable use">
        <p>
          Follow our{" "}
          <Link to="/guidelines" className="font-semibold text-brand underline">
            Community Guidelines
          </Link>
          . In short: no harassment, hate, illegal content, sexual content involving minors, spam,
          impersonation, manipulation of engagement, or attempts to break, overload or scrape the
          service.
        </p>
      </Section>

      <Section title="4. Plans and subscriptions">
        <p>
          We offer Free, Plus and Pro plans. Paid subscriptions renew automatically until you cancel
          — you can cancel any time and keep the plan until the end of the period you paid for.
          Prices may change with notice; refunds follow the law of your country and, where required,
          we'll refund duplicate or erroneous charges.
        </p>
      </Section>

      <Section title="5. Tips, earnings and withdrawals">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Tips are final once sent.</strong> They go to the
            creator or team you chose and arrive at 100% — we take nothing when a tip lands.
          </li>
          <li>
            <strong className="text-foreground">Withdrawal fees.</strong> When a creator cashes out,
            the platform keeps a percentage set by the earner's plan: 5% on Free, 3% on Plus, 1% on
            Pro. The fee and the exact amount reaching your account are shown before you confirm
            each withdrawal.
          </li>
          <li>
            <strong className="text-foreground">Currency.</strong> Balances are held and requested
            in US dollars; withdrawals are delivered in your local currency at the conversion shown
            at the time of the request.
          </li>
          <li>
            <strong className="text-foreground">Failed transfers.</strong> A withdrawal that doesn't
            complete is returned to your balance automatically.
          </li>
          <li>
            <strong className="text-foreground">Taxes.</strong> You're responsible for your own
            taxes on earnings. Team earnings belong to the workspace and can only be withdrawn by
            its owner.
          </li>
        </ul>
      </Section>

      <Section title="6. Team workspaces">
        <p>
          Workspace content, tips and earnings belong to the workspace, not to the individual member
          who posted. Owners and admins manage members; roles decide who can publish, repost and
          manage. A departing member keeps nothing they published under the team — that was always
          the team's.
        </p>
      </Section>

      <Section title="7. Developer API">
        <p>
          API keys are personal and must be kept secret. Your keys act as you. We may rate-limit or
          revoke keys that are abused, and developers are responsible for how their integrations use
          the platform.
        </p>
      </Section>

      <Section title="8. Suspension and termination">
        <p>
          You can stop using {name} at any time and ask us to delete your account — email{" "}
          <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>
            {appConfig.brand.supportEmail}
          </a>{" "}
          from your registered address, and we close it and remove your content and files within 30
          days, keeping only the reduced payment records the law requires. The{" "}
          <Link to="/privacy" className="font-semibold text-brand underline">
            Privacy Policy
          </Link>{" "}
          sets out exactly what happens to each category of data. We may warn, restrict or suspend
          accounts that break these terms — immediately for serious cases like illegal content.
          Suspended accounts can appeal through Support. Payments already made for the current
          period are non-refundable except where the law requires.
        </p>
      </Section>

      <Section title="9. Disclaimers and liability">
        <p>
          The service is provided "as is". To the extent allowed by law, we aren't liable for
          indirect or consequential losses, and our total liability for any claim is limited to the
          amount you paid us in the twelve months before the claim. Nothing here excludes liability
          we can't lawfully exclude.
        </p>
      </Section>

      <Section title="10. Changes">
        <p>
          We may update these terms; material changes are announced in the product before they take
          effect, and the date above changes. Continuing to use {name} after a change means you
          accept it.
        </p>
      </Section>

      <Section title="11. Contact">
        <p>
          Questions about these terms:{" "}
          <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>
            {appConfig.brand.supportEmail}
          </a>{" "}
          or the{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            contact form
          </Link>
          . See also the{" "}
          <Link to="/privacy" className="font-semibold text-brand underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>
    </StaticPage>
  );
}
