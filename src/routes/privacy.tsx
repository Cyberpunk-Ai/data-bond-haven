import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta } from "@/lib/seo";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;
const email = appConfig.brand.supportEmail;

/**
 * This page is the privacy policy Google (and any regulator) reads, so its bar
 * is different from marketing copy: it has to name the data, the purpose, the
 * recipients and the retention period, and it has to match what the code
 * actually does. Every claim below is traceable to the implementation —
 *
 *   Google sign-in fields          src/routes/auth.tsx (signInWithOAuth "google")
 *   Payout envelope encryption     src/lib/payout-vault.server.ts (AES-256-GCM)
 *   Short-lived media tokens       src/lib/media-token.server.ts (HMAC, 30 min)
 *   Space recording + plan caps    src/lib/spaces-storage.ts, SpaceRoomModal.tsx
 *   Per-plan storage budgets       db/migrations/20260930000093_*.sql
 *   Revoked direct client writes   db/migrations/20260930000094_*.sql
 *
 * If you add a new processor, a new scope, or a new category of collected data,
 * update the matching section here in the same change.
 */
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: `Privacy Policy — ${name}` },
      {
        name: "description",
        content: `The personal data ${name} collects, the purpose of each category, who processes it, how long we keep it, how it is protected, and how to exercise your rights — including data received from Google sign-in.`,
      },
      { property: "og:title", content: `Privacy Policy — ${name}` },
      {
        property: "og:description",
        content: `What ${name} collects, why, who it goes to, how long it stays, and your rights.`,
      },
      { property: "og:type", content: "article" },
      // The site card is this page's picture, and it is 1200x630 — a `summary`
      // card would shrink that banner to a thumbnail next to the text.
      { name: "twitter:card", content: "summary_large_image" },
      ogUrlMeta("/privacy"),
    ],
    links: [canonicalLink("/privacy")],
  }),
  component: Privacy,
});

const CONTENTS = [
  { id: "summary", label: "1. The short version" },
  { id: "who", label: "2. Who we are and what this covers" },
  { id: "given", label: "3. Information you give us" },
  { id: "google", label: "4. Information we receive from Google" },
  { id: "automatic", label: "5. Information we collect automatically" },
  { id: "purposes", label: "6. Why we process it (purposes and legal bases)" },
  { id: "sharing", label: "7. Who we share it with" },
  { id: "visible", label: "8. What other people can see" },
  { id: "messages", label: "9. Messages, calls and Space recordings" },
  { id: "ai", label: "10. AI drafting and third-party AI providers" },
  { id: "cookies", label: "11. Cookies, local storage and tracking" },
  { id: "retention", label: "12. How long we keep each category" },
  { id: "security", label: "13. How we protect your data" },
  { id: "rights", label: "14. Your rights and choices" },
  { id: "deletion", label: "15. Deleting your account and your data" },
  { id: "children", label: "16. Children" },
  { id: "transfers", label: "17. Where your data is processed" },
  { id: "changes", label: "18. Changes to this policy" },
  { id: "contact", label: "19. How to contact us" },
];

function Privacy() {
  return (
    <StaticPage
      eyebrow="Legal"
      title="Privacy Policy"
      intro={`${name} is a social network for creators and communities — posts and stories, live audio rooms, direct messages and calls, team workspaces, tips and payouts. This policy explains exactly which personal data we collect to make each of those features work, the purpose of every category, who processes it, how long we keep it, how it is protected, and how you exercise your rights. We do not sell personal data and we do not run behavioural advertising.`}
      updated="30 September 2026 (version 2)"
    >
      <Section title="1. The short version" id="summary">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">What we collect:</strong> the details you add to
            your account, the content you post, the transactions you make, and the technical logs
            needed to run and secure the service (sections 3–5).
          </li>
          <li>
            <strong className="text-foreground">From Google we receive:</strong> your name, email
            address, profile picture and a stable Google user ID — nothing else, because we only ask
            for the OpenID, email and profile permissions (section 4).
          </li>
          <li>
            <strong className="text-foreground">Why:</strong> to provide the features you asked for,
            to keep accounts secure and to process payments. Not for advertising — we have no
            advertising product (section 6).
          </li>
          <li>
            <strong className="text-foreground">Who sees it:</strong> the people you choose to
            interact with, the staff who run the service, and the named infrastructure providers in
            section 7. We do not sell personal data or share it with data brokers or ad networks.
          </li>
          <li>
            <strong className="text-foreground">Card and bank data:</strong> card details are
            handled by our licensed payment provider and never reach our servers; payout account
            details are stored encrypted with AES-256-GCM (section 13).
          </li>
          <li>
            <strong className="text-foreground">You stay in control:</strong> you can correct or
            delete content in the product, restrict who can contact you, download a copy of your
            data on request, and close your account (sections 14–15).
          </li>
        </ul>
        <p>
          If you only read one thing: this policy is written to match the code. Where the product
          and this page disagree, this page governs and we will fix the product.
        </p>
      </Section>

      <Section title="Contents" id="contents">
        <ul className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {CONTENTS.map((c) => (
            <li key={c.id}>
              <a href={`#${c.id}`} className="text-brand underline decoration-brand/40">
                {c.label}
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="2. Who we are and what this policy covers" id="who">
        <p>
          <strong className="text-foreground">The service.</strong> {name} (
          <a className="text-brand underline" href="https://spaces1.com">
            spaces1.com
          </a>
          ) is a social platform where people publish posts, stories and photos; host and join live
          audio rooms called Spaces; send direct messages and make voice or video calls; organise
          multi-person workspaces that publish as one account; and receive tips and withdraw
          earnings. A public developer API with webhooks is available to Pro accounts.
        </p>
        <p>
          <strong className="text-foreground">Who we are.</strong> The operators of {name} are the
          data controller for the personal data described here. Contact us at{" "}
          <a className="text-brand underline" href={`mailto:${email}`}>
            {email}
          </a>{" "}
          (subject line "privacy") for anything in this policy, including requests to exercise your
          rights.
        </p>
        <p>
          <strong className="text-foreground">Scope.</strong> This policy applies to the website,
          the installable web app and the API, and to anyone with a {name} account or who interacts
          with a person who has one. It does not apply to third-party services we link to — for
          example a creator's own website — which set their own rules.
        </p>
        <p>
          <strong className="text-foreground">Related documents.</strong> The{" "}
          <Link to="/terms" className="font-semibold text-brand underline">
            Terms of Service
          </Link>{" "}
          govern your use of the service, and the{" "}
          <Link to="/guidelines" className="font-semibold text-brand underline">
            Community Guidelines
          </Link>{" "}
          set the rules for content. Together they are the whole agreement between us.
        </p>
      </Section>

      <Section title="3. Information you give us" id="given">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Account and sign-in:</strong> email address,
            password (stored only as a salted hash by our authentication provider), your chosen
            username and display name, sign-in method (email link, password, or Google), and the
            session tokens used to keep you signed in.
          </li>
          <li>
            <strong className="text-foreground">Profile:</strong> display name, @username, avatar
            image, biography, location label you choose to add, links, and your plan and
            verification status.
          </li>
          <li>
            <strong className="text-foreground">Content you create:</strong> posts, comments and
            replies, stories (which expire automatically), polls, reactions, the text and media you
            upload, and the chat messages you send inside a live Space.
          </li>
          <li>
            <strong className="text-foreground">Media files:</strong> images, video, audio and
            documents you upload, including voice notes and any Space recording you choose to keep.
          </li>
          <li>
            <strong className="text-foreground">Money details:</strong> tip amounts, subscription
            plan, billing cycle, payment reference, transaction status, the payout account
            information you type when withdrawing, and the last digits we keep for your own records.
            Full card numbers, CVVs and CVCs are entered on our payment provider's side and never
            touch {name} servers.
          </li>
          <li>
            <strong className="text-foreground">Workspaces:</strong> the email addresses of team
            members you invite, their role in the team, and the team's content and earnings records.
          </li>
          <li>
            <strong className="text-foreground">Support and safety reports:</strong> messages you
            send us, reports you file about content or accounts, your appeals, and the evidence you
            attach.
          </li>
        </ul>
        <p>
          You do not have to give us any of the above, but the features that need them will not work
          — for example a payout destination is required to withdraw earnings.
        </p>
      </Section>

      <Section
        title="4. Information we receive from Google when you sign in with Google"
        id="google"
      >
        <p>
          If you use the "Continue with Google" button, {name} redirects you to Google through our
          authentication provider and receives an OpenID Connect token back. We request only the
          standard <code>openid</code>, <code>email</code> and <code>profile</code> scopes, so
          Google shares exactly these four things with us:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Your Google name</strong> — used to prefill your
            display name, which you can change at any time.
          </li>
          <li>
            <strong className="text-foreground">Your Google email address</strong> — used to create
            and recognise your {name} account, to send account-security emails, and to let you sign
            in again if you stop using Google.
          </li>
          <li>
            <strong className="text-foreground">Your profile picture URL</strong> — used to set your
            initial avatar, which you can replace.
          </li>
          <li>
            <strong className="text-foreground">A stable Google user ID</strong> — a unique
            identifier we store against your account so the same Google account always maps back to
            the same {name} account. It is not shared with other users.
          </li>
        </ul>
        <p>
          <strong className="text-foreground">What we do not ask for.</strong> We never request
          access to Gmail, Google Drive, Contacts, Calendar, Photos, YouTube or any other Google
          service, and we do not ask for sensitive scopes. {name} cannot see your Google files or
          mail.
        </p>
        <p>
          <strong className="text-foreground">
            Google API data: we limit our use of Google information (Limited Use).
          </strong>{" "}
          We only use information we receive from Google interfaces to provide and improve the
          single feature you asked for — signing you in and labelling your account. Specifically, in
          line with{" "}
          <a
            className="text-brand underline"
            href="https://developers.google.com/identity/protocols/oauth2/api-limited-use"
            target="_blank"
            rel="noreferrer"
          >
            Google's Limited Use requirements
          </a>
          , we do not use Google API data for advertising; we do not share or transfer it to third
          parties except as described in section 7 with your consent or as required by law; we do
          not use it to generate or update a data profile about you, and we do not scan it for
          commercial purposes. It is not retained after your account is deleted (section 15).
        </p>
        <p>
          <strong className="text-foreground">Separate Google services we also contact.</strong>{" "}
          Beyond sign-in, three technical features reach Google infrastructure: web fonts are loaded
          from Google Fonts (Google sees the requesting IP address), peer-to-peer calls use Google's
          public STUN servers to discover network addresses, and — only if you press an AI drafting
          or summarise button — the text you ask about is sent to an AI provider (section 10). None
          of these gives Google access to your {name} account.
        </p>
        <p>
          You can disconnect Google from {name} at any time: remove the authorisation on your{" "}
          <a
            className="text-brand underline"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            Google permissions page
          </a>
          , and use an email-and-password sign-in instead.
        </p>
      </Section>

      <Section title="5. Information we collect automatically" id="automatic">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Device and browser:</strong> user-agent string,
            screen size, platform, and language preference — used to lay out the app and to spot
            impossible sign-ins.
          </li>
          <li>
            <strong className="text-foreground">Network data:</strong> IP address and the coarse
            country or city derived from it, plus the network type reported by your browser. We use
            this for fraud and abuse prevention, rate limiting, and to show content in your
            language; we do not track precise geolocation and the app never asks for GPS permission.
          </li>
          <li>
            <strong className="text-foreground">Sign-in and security logs:</strong> timestamps of
            authentication events, password and email-change attempts, failed authorisation
            attempts, and the API keys used against the developer API. These exist to let you and us
            notice unauthorised access.
          </li>
          <li>
            <strong className="text-foreground">Engagement events:</strong> which posts you view,
            like, repost, bookmark, reply to or tip on, how long a Space you joined was live, and
            which notifications you opened. This is what powers your feed ranking, your counters,
            the notification system, and the analytics a creator sees about their own posts.
          </li>
          <li>
            <strong className="text-foreground">Error reports:</strong> when something breaks we log
            the technical stack trace, the page it happened on and a request identifier so we can
            fix it. We do not use crash reporting to build a profile of you.
          </li>
          <li>
            <strong className="text-foreground">Call and Space audio:</strong> live audio is
            streamed between participants for the duration of the room and is not stored (section
            9).
          </li>
        </ul>
        <p>
          <strong className="text-foreground">Location labels on posts.</strong> If you tag a
          location while composing, the text you type is looked up against the OpenStreetMap
          Nominatim geocoder, so that service receives the place name you searched for. The lookup
          is sent from our servers, so it does not carry your device or IP address. Only the label
          you choose is stored with the post — never a live location and never a precise coordinate
          you did not type.
        </p>
      </Section>

      <Section title="6. Why we process it: purposes and legal bases" id="purposes">
        <p>
          Each category of data exists to serve a specific purpose. We list the purpose and the
          legal basis we rely on (the wording follows the EU/UK GDPR; outside those regions it is
          offered as a transparency measure).
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Providing the service you registered for</strong> —
            accounts, profiles, posting, feeds, Spaces, messages, calls, workspaces, analytics, API
            access. Basis: performance of a contract.
          </li>
          <li>
            <strong className="text-foreground">Taking payment and paying creators</strong> — tips,
            subscriptions, withdrawals, refunds, fee calculation, receipts. Basis: performance of a
            contract and, for records we must keep, legal obligation.
          </li>
          <li>
            <strong className="text-foreground">Account security and fraud prevention</strong> —
            verifying sign-ins, rate limiting, blocking stolen-credential abuse, detecting fake
            engagement, protecting minors. Basis: legitimate interests (a safe platform) and legal
            obligation.
          </li>
          <li>
            <strong className="text-foreground">Content moderation, reports and appeals</strong> —
            reviewing material reported to us, applying the Community Guidelines, handling appeals
            and legal notices. Basis: legitimate interests and legal obligation.
          </li>
          <li>
            <strong className="text-foreground">Personalising your feed and recommendations</strong>{" "}
            — ranking posts using the accounts you follow and the things you engage with. Basis:
            legitimate interests; you can retune or turn this off in your feed settings.
          </li>
          <li>
            <strong className="text-foreground">Transactional emails</strong> — verification,
            password reset, receipts and required service notices. Basis: performance of a contract
            and legitimate interests. We do not send marketing email, so there is nothing to
            unsubscribe from.
          </li>
          <li>
            <strong className="text-foreground">Product analytics and diagnostics</strong> —
            first-party counts of which features are used, so we know what to maintain. Basis:
            legitimate interests. We do not use third-party analytics or advertising trackers.
          </li>
          <li>
            <strong className="text-foreground">Optional AI assistance</strong> — drafting or
            summarising text you explicitly ask for. Basis: consent, which you can withdraw by
            simply not using the feature (section 10).
          </li>
        </ul>
        <p>
          We do not make automated decisions that have legal or similarly significant effects on
          you. Feed ranking and recommendations decide what you see, not whether you get paid, and
          moderation actions are reviewed by a person on request.
        </p>
      </Section>

      <Section title="7. Who we share your information with" id="sharing">
        <p>
          We disclose personal data only to the companies that process it on our instructions to run
          the platform, and only the minimum each one needs. By category:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Infrastructure and database</strong> — Supabase
            (managed PostgreSQL, authentication, file storage and realtime message delivery), hosted
            on Amazon Web Services. Your account data, content, messages and media are processed
            there.
          </li>
          <li>
            <strong className="text-foreground">Object storage</strong> — either Supabase Storage or
            an S3-compatible bucket we configure (for example Cloudflare R2, Backblaze B2, Wasabi,
            DigitalOcean Spaces or Amazon S3). Uploaded media lives there under opaque keys; private
            media is served through our authorised proxy with short-lived signed links rather than
            straight from the bucket.
          </li>
          <li>
            <strong className="text-foreground">Payments</strong> — Paystack (a Stripe company) for
            card charges, subscription billing and payout transfers, and its own banking and
            card-network partners. They receive the payment details and the identity data needed to
            move money and to satisfy financial-crime rules. Their privacy notice covers that step.
          </li>
          <li>
            <strong className="text-foreground">Identity providers</strong> — Google, when you
            choose to sign in with it (section 4).
          </li>
          <li>
            <strong className="text-foreground">Communication infrastructure</strong> — Google Fonts
            for typography, public STUN servers (operated by Google) and, when enabled, a TURN relay
            provider to keep calls connected, and OpenStreetMap Nominatim for the location search
            box. Each receives only the technical request data described in section 5.
          </li>
          <li>
            <strong className="text-foreground">Optional AI provider</strong> — the
            large-language-model gateway configured for drafting and summaries receives the prompt
            you submit (section 10). Turning the feature off means nothing is sent.
          </li>
          <li>
            <strong className="text-foreground">Your own connections</strong> — your posts,
            comments, profile and any Space you speak in are visible to other users according to
            your privacy settings; the people in a conversation can see what you send them.
          </li>
          <li>
            <strong className="text-foreground">Trusted advisers and successors</strong> — our
            accountants and lawyers under confidentiality, and, in a corporate transaction, a buyer
            bound to honour this policy.
          </li>
          <li>
            <strong className="text-foreground">Authorities</strong> — law enforcement, courts or a
            regulator, only when we are legally required or permitted to protect rights, safety or
            property. We disclose the minimum required and tell you when we are allowed to.
          </li>
        </ul>
        <p>
          <strong className="text-foreground">What we never do.</strong> We do not sell personal
          data, we do not share it for cross-context behavioural advertising, we do not let third
          parties place advertising trackers on our pages, and we do not provide data brokers with
          access to user records. Creators can see aggregate analytics about their own audience, not
          identities of people who do not follow them.
        </p>
        <p>
          Moderators and support staff at {name} can access content that has been reported to them,
          or that a user asks them about, under strict role-based permissions and with an audit
          trail of every such action. Access is granted per role and reviewed.
        </p>
      </Section>

      <Section title="8. What other people can see" id="visible">
        <p>
          {name} is a public-by-default social network, and it is worth being explicit about it:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">
              Visible to everyone, including logged-out visitors:
            </strong>{" "}
            your display name, @username, avatar, biography and the posts, stories and Spaces you
            choose to publish publicly, plus your follower and post counts. Search engines can index
            those pages.
          </li>
          <li>
            <strong className="text-foreground">
              Visible to your followers or to people you pick:
            </strong>{" "}
            posts and stories you limit to them, according to the audience control on the composer.
          </li>
          <li>
            <strong className="text-foreground">Visible only to you and the people in it:</strong>{" "}
            direct messages, their attachments and voice notes, private group conversations, call
            content, drafts, bookmarks, your email address, your plan, your balance and any Space
            recording you keep.
          </li>
        </ul>
        <p>
          Your email address is never shown on your public profile and is only disclosed to the
          authentication and support systems that need it.
        </p>
      </Section>

      <Section title="9. Direct messages, calls and Space recordings" id="messages">
        <p>
          <strong className="text-foreground">Private does not mean end-to-end encrypted.</strong>{" "}
          Direct messages, voice notes and attachments are stored so that the conversation works
          across your devices and survives reconnecting. They are protected by access controls (only
          the participants can read them), by encryption in transit and at rest, and by audit
          logging — but they are not end-to-end encrypted, which means that the technical systems we
          operate can in principle read them. We rely on that only for the purposes in section 6:
          responding to a report about a conversation you are part of, complying with a legal
          notice, or restoring data you ask us to restore. We do not read conversations to build
          advertising or profiles, and every staff access to message content is logged.
        </p>
        <p>
          <strong className="text-foreground">Calls and live Spaces.</strong> Audio and video travel
          peer-to-peer where the network allows, and through a relay when it does not. A live room
          is transient: nothing is written to disk while it is going on. Media connections do
          exchange IP addresses with other participants to establish the connection, which is how
          peer-to-peer communication works — a participant in a room with you can see your network
          address.
        </p>
        <p>
          <strong className="text-foreground">
            Recordings happen only when a host starts them.
          </strong>{" "}
          When a recording begins, the room announces it to everyone present and an indicator stays
          visible while it is running, so nobody is recorded silently. Joining a recording Space is
          your choice, and you can leave at any time. A recording is stored against the host's
          account and counts against their plan's storage budget, it is private to the host (other
          people, including past participants, cannot open the replay), and it can be deleted by the
          host at any time — deleting the recording removes the stored audio and the file from our
          storage backend.
        </p>
      </Section>

      <Section title="10. AI drafting and third-party AI providers" id="ai">
        <p>
          AI features are optional, off unless you use them, and can be switched off platform-wide
          by the operator. When you press a "draft", "improve" or "summarise this Space" action, the
          text you supply — plus the minimum surrounding context needed to be useful, such as the
          prompt and the room's transcript after you end it — is sent to the large-language-model
          endpoint we have configured, currently Google's Gemini API through an OpenAI-compatible
          gateway. That provider processes the text to produce a response under its own terms; we do
          not send them your password, payment details or your full account. Draft text is returned
          to you and is not stored by {name} unless you choose to publish it. AI assistance is
          disclosed in the interface whenever it generates something for you, and the Community
          Guidelines require you to label substantial AI-generated content you post.
        </p>
      </Section>

      <Section title="11. Cookies, local storage and tracking" id="cookies">
        <p>We use first-party browser storage only. What is kept in your browser:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Your session</strong> — the authentication tokens
            that keep you signed in and refresh securely. Clearing them signs you out.
          </li>
          <li>
            <strong className="text-foreground">Interface preferences</strong> — your theme, which
            team workspace is active, and small UI state such as dismissed notices.
          </li>
          <li>
            <strong className="text-foreground">Feed cache</strong> — a short-lived copy of the
            content you have already loaded, so scrolling back is instant.
          </li>
        </ul>
        <p>
          We set no advertising cookies, no cross-site trackers and no third-party analytics
          cookies, so there is no cookie consent banner: everything we store is essential to the
          feature you asked for. Because the app can be installed to a phone or desktop as a web
          app, it can register a service worker for that purpose and ask your browser whether you
          want notifications; both are under your control, and notifications can be turned off in
          browser settings and in your {name} settings. Browsers that send a "Do Not Track" or
          "Global Privacy Control" signal find nothing to track on {name}, since we run no tracking
          scripts.
        </p>
      </Section>

      <Section title="12. How long we keep each category" id="retention">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Account and profile data:</strong> for as long as
            your account exists, then deleted within 30 days of closure.
          </li>
          <li>
            <strong className="text-foreground">Posts, comments, stories:</strong> until you delete
            them or your account is closed. Stories additionally expire automatically within days of
            being posted, whatever you do.
          </li>
          <li>
            <strong className="text-foreground">Direct messages:</strong> until the sender or a
            participant deletes them, or your account is closed.
          </li>
          <li>
            <strong className="text-foreground">Uploaded media:</strong> as long as the content that
            references it exists; unused uploads are reclaimed automatically shortly after upload,
            and media belonging to deleted content is removed by a periodic sweep.
          </li>
          <li>
            <strong className="text-foreground">Space recordings:</strong> until the host deletes
            them, or the room's storage budget is reclaimed. Live audio that was never recorded is
            not kept at all.
          </li>
          <li>
            <strong className="text-foreground">Payment and payout records:</strong> we keep the
            transaction record — amount, date, reference, status — for seven years, or the minimum
            required by the tax and financial-reporting law that applies to us if that is longer,
            and we keep it even after an account closes because the obligation is ours. Balance
            history and the payout destination are removed with your account.
          </li>
          <li>
            <strong className="text-foreground">Security and API logs:</strong> authentication and
            abuse-prevention events for up to twelve months; rate-limiting windows for minutes; API
            call metadata for as long as the developer integration exists.
          </li>
          <li>
            <strong className="text-foreground">Reports, appeals and moderation records:</strong>{" "}
            for as long as needed to keep the platform safe, to honour legal holds and to defend or
            bring claims — typically the length of the restriction plus a limitation period.
          </li>
          <li>
            <strong className="text-foreground">Backups:</strong> encrypted database backups rotate,
            so data that has been deleted is also removed from backup copies when they expire.
          </li>
        </ul>
      </Section>

      <Section title="13. How we protect your data" id="security">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Encryption in transit</strong> on every connection
            (HTTPS/TLS for the app and API; TLS for our database connections), and encryption at
            rest by our infrastructure providers.
          </li>
          <li>
            <strong className="text-foreground">Row-level security in the database</strong> so that
            every read and write is filtered to the acting user, and so that a bug in application
            code cannot read someone else's rows. Sensitive tables — tips, payouts, notifications,
            impression logs, the migration ledger — are additionally closed to direct client writes
            entirely and can only be changed by server-side code with the right role.
          </li>
          <li>
            <strong className="text-foreground">Secrets kept server-side.</strong> Credentials that
            bypass user permissions never reach the browser, and configuration the browser must know
            is public by definition. Server-only modules are separated at build time so a mistake
            cannot ship them to a client.
          </li>
          <li>
            <strong className="text-foreground">Money-specific controls.</strong> Card data is
            tokenised by our PCI-compliant payment provider and never stored by us. Payout
            destinations are encrypted with AES-256-GCM using keys derived from a server-side secret
            and are decrypted only to move money. Webhooks that tell us a payment landed are
            signature-checked and each event is processed once.
          </li>
          <li>
            <strong className="text-foreground">Private media is never public by accident.</strong>{" "}
            Direct messages, recordings and stories are served through an authorising proxy that
            checks the requesting user and issues a short-lived signed URL (about 30 minutes),
            rather than relying on an unguessable link.
          </li>
          <li>
            <strong className="text-foreground">Abuse resistance.</strong> Passwords are salted and
            hashed by our authentication provider, sign-ins and writes are rate limited, sessions
            are revocable, developer API keys are stored only as salted hashes with per-key limits,
            and administrative actions are written to an audit log.
          </li>
          <li>
            <strong className="text-foreground">People controls.</strong> Staff access is
            least-privilege and role-scoped, and we operate an internal change-review process for
            production access.
          </li>
        </ul>
        <p>
          No system is impenetrable, and we will not pretend otherwise. If you believe your account
          is compromised, change your password, sign out everywhere and{" "}
          <a className="text-brand underline" href={`mailto:${email}`}>
            tell us immediately
          </a>
          . If a breach affects your personal data in a way the law requires us to report, we will
          notify you and the relevant authority without undue delay.
        </p>
      </Section>

      <Section title="14. Your rights and choices" id="rights">
        <p>
          Depending on where you live, you have some or all of the following rights over your
          personal data: access and a portable copy; rectification of anything inaccurate; erasure;
          restriction or objection to processing; withdrawal of consent; the right not to be
          discriminated against for using them; and, in the EU, UK and several other jurisdictions,
          the right to lodge a complaint with a supervisory authority.
        </p>
        <p>
          You can exercise most of them yourself, immediately and without asking us, inside the
          product:{" "}
          <Link to="/settings" className="font-semibold text-brand underline">
            Settings
          </Link>{" "}
          lets you correct your profile, change your email and password, control who can message or
          reply to you, tune your feed away from topics you do not want, manage notifications,
          connect or disconnect a workspace, and download the receipts for your transactions. You
          can delete any post, comment, message or recording you control. You can mute, block and
          report anyone.
        </p>
        <p>For the rest, email us from the address on your account:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">A copy of your data</strong> — we will send an
            export of your profile, content and transaction history in a machine-readable format
            (JSON), typically within 30 days.
          </li>
          <li>
            <strong className="text-foreground">Correction or erasure</strong> of data you cannot
            change yourself, including content another account published about you where it breaks
            our rules.
          </li>
          <li>
            <strong className="text-foreground">Objection or restriction</strong> — for example
            objecting to feed personalisation, which you can also switch off in settings.
          </li>
          <li>
            <strong className="text-foreground">A decision review</strong> if your account is
            suspended or your content is removed: reply to the notice or contact us, and a person
            will look again.
          </li>
        </ul>
        <p>
          Requests are free, answered within 30 days, and we may need to confirm it is really your
          account before we act — usually by asking you to write from the registered email address.
          We will not hand over data about other users in an export.
        </p>
      </Section>

      <Section title="15. Deleting your account and your data" id="deletion">
        <p>
          To close your {name} account, email{" "}
          <a className="text-brand underline" href={`mailto:${email}`}>
            {email}
          </a>{" "}
          from your registered address (or use the{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            contact form
          </Link>{" "}
          and quote your @username) with the subject "delete my account". You do not need to explain
          why. We will confirm, and then:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Your login is disabled immediately and your profile, posts, comments, stories,
            reactions, bookmarks and Space rooms stop being attributable to you; anonymous
            placeholder text is used where a public record must remain for a conversation to make
            sense.
          </li>
          <li>
            Your direct messages, uploads, kept recordings and workspace memberships are removed
            within 30 days, along with the files in storage that nothing else references.
          </li>
          <li>
            We keep only what the law obliges us to keep — the reduced payment and tax record
            described in section 12 and the moderation trail for any action taken against the
            account — separated from active user data.
          </li>
          <li>
            Any subscription is cancelled and not renewed, and outstanding earnings must be
            withdrawn or are handled according to the Terms before closure completes.
          </li>
        </ul>
        <p>
          If you signed in with Google, also remove {name} from your{" "}
          <a
            className="text-brand underline"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            Google third-party access list
          </a>{" "}
          — that ends our ability to receive your Google profile data again. Deleting your Google
          account is a separate action you take with Google.
        </p>
        <p>
          Deleting your account does not delete copies other people legitimately made — screenshots,
          or replies on their own posts — and content published by a workspace continues to belong
          to that workspace, as the Terms explain.
        </p>
      </Section>

      <Section title="16. Children" id="children">
        <p>
          {name} is not for children under 13, and in regions where the age of digital consent is
          higher (16 in much of the EU/UK for information-society services) we rely on your
          declaration that you meet your local minimum. We do not knowingly collect personal data
          from children, we do not target the service at them, and we do not ask for their data.
          Verification checks exist for accounts that show signs of being underage. If you are a
          parent or guardian who believes a child has given us personal data, contact us at the
          address below and we will investigate and delete the account and its data.
        </p>
      </Section>

      <Section title="17. Where your data is processed and transferred" id="transfers">
        <p>
          {name} is a global service, and a social network only works if content can travel. Our
          primary database and authentication systems are hosted on Amazon Web Services in the
          eu-west-1 region (Ireland) through Supabase; object storage is in the region configured
          for our storage account, and our payment provider operates in Nigeria and the United
          States with its own global infrastructure. That means personal data may be processed in
          countries other than your own, including countries whose data-protection laws differ from
          yours.
        </p>
        <p>
          Where a transfer needs safeguards, we rely on the European Commission's Standard
          Contractual Clauses (and the UK Addendum), on adequacy decisions where they apply, and on
          the contractual and technical measures in section 13. In practice: encryption in transit
          and at rest, least-privilege access, and disclosure only as described in section 7.
        </p>
      </Section>

      <Section title="18. Changes to this policy" id="changes">
        <p>
          We update this policy as the product changes. When a change materially affects how we
          handle personal data, we will tell people in the product and by email at least 14 days
          before it takes effect, and the version note at the top of this page will change. Material
          changes do not apply retroactively to data you deleted. Older versions are available on
          request.
        </p>
      </Section>

      <Section title="19. How to contact us" id="contact">
        <p>
          Privacy questions, rights requests, complaints and reports about a child's data: email{" "}
          <a className="text-brand underline" href={`mailto:${email}`}>
            {email}
          </a>{" "}
          with "privacy" in the subject line, or use the{" "}
          <Link to="/contact" className="font-semibold text-brand underline">
            contact form
          </Link>
          . We acknowledge requests within 5 days and answer within 30. For rules and reporting
          tools that affect what you see, see the{" "}
          <Link to="/guidelines" className="font-semibold text-brand underline">
            Community Guidelines
          </Link>{" "}
          and the{" "}
          <Link to="/help" className="font-semibold text-brand underline">
            Help Center
          </Link>
          ; the money terms are in the{" "}
          <Link to="/terms" className="font-semibold text-brand underline">
            Terms of Service
          </Link>
          .
        </p>
      </Section>
    </StaticPage>
  );
}
