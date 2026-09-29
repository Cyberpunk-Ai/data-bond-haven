# Spaces1

A social platform for ideas, spaces and live audio: feed + stories, DMs with
attachments, Google Voice-style **Spaces** (live audio rooms with recordings),
tipping/monetization, team workspaces, a developer API and an admin console.

**Live app**: https://spaces1.com

## Stack

| Layer                  | Choice                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| App                    | [TanStack Start](https://tanstack.com/start) (React 19, file-based routes, SSR + server functions)                                     |
| Data / auth / realtime | Supabase (Postgres + PostgREST + GoTrue + Realtime), RLS everywhere                                                                    |
| Migrations             | `db/migrations/*.sql` applied by `scripts/db-migrate.mjs` (checksummed, forward-only)                                                  |
| Object storage         | Any S3-compatible store (Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, MinIO, AWS S3) — or the Supabase bucket as fallback |
| Payments               | Paystack (tips + plan checkout)                                                                                                        |
| AI                     | Any OpenAI-compatible chat endpoint (Gemini by default)                                                                                |
| Build                  | Vite 8 + Tailwind v4, Nitro `node-server` output (`.output/server/index.mjs`)                                                          |
| Tooling                | TypeScript strict, ESLint, Prettier, Vitest                                                                                            |

## Quick start

Requires Node.js 20+ ([nvm](https://github.com/nvm-sh/nvm#installing-and-updating)).

```sh
git clone <this-repository-url>
cd data-bond-haven
npm install
copy .env.example .env      # fill in Supabase URL + keys
npm run dev                 # http://localhost:8080
```

Production shape:

```sh
npm run build && npm start  # serves .output/server/index.mjs on port 3000
```

### Commands and the URL each one prints

| Command               | What you get                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`         | Vite dev SSR on **http://localhost:8080** (if 8080 is taken Vite moves to 8081 and says so)      |
| `npm run dev:open`    | same, and hands the link to your default browser                                                 |
| `npm run build`       | production bundle in `.output/` (Nitro `node-server`, pre-compressed assets)                     |
| `npm start`           | serves that bundle on **http://localhost:3000** — checks the build exists and the port is free   |
| `npm start -- --open` | same, opens the browser once the port answers                                                    |
| `npm run preview`     | `npm run build` then serve, one command                                                          |
| `npm run serve`       | the bare `node .output/server/index.mjs` — what a container should run so the server keeps PID 1 |

Nitro's build hint ("you can preview this build using `npx vite preview`") does
not apply here: `vite preview` looks for `dist/server/server.js`, while Nitro
writes everything to `.output/` — so `preview` is wired to the build-and-serve
runner instead. Stop any running server before rebuilding: on Windows a live
server holds `.output/` open and `vite build` aborts with `ENOTEMPTY` (which is
also why `npm run preview` refuses to start while the port is busy).

Both servers honour `PORT` (shell, then `.env`) and `HOST`; `npm start -- --port
3005` overrides for one run. To open the app from a phone or tablet, use the
LAN address the banner prints — it names each adapter, so you can pick your Wi-Fi
over a VPN or VirtualBox range — because the server binds every interface.

Everything else: `npm run typecheck`, `npm run test`, `npm run lint`,
`npm run format`, `npm run db:migrate` (+ `:status` / `:dry` / `db:backup` /
`db:restore`).

## Configuration

[`.env.example`](.env.example) is the contract: one section per trust boundary,
every key read by code documented there.

- `VITE_*` — inlined into the public bundle at build time. **Never** put a
  secret in this section.
- Server keys — read only through `src/lib/env.server.ts`, which validates
  lazily and fails loudly, naming the missing key. Production requires
  `API_KEY_PEPPER` (≥ 32 chars) and a `sk_live_…` Paystack secret.

### Object storage (media) is a provider, not a vendor

The app talks to one interface —
[`StorageProvider`](src/lib/storage/provider.server.ts) — and
`src/lib/storage/index.server.ts` picks the implementation from the environment.
Adding credentials is the whole migration:

```env
STORAGE_PROVIDER=auto           # auto | s3 | supabase
R2_ACCOUNT_ID=<account id>      # endpoint is derived from this
R2_BUCKET=<bucket>
R2_ACCESS_KEY_ID=<token id>
R2_SECRET_ACCESS_KEY=<token secret>
S3_REGION=auto
```

…or point `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` at
any other S3-compatible endpoint (`S3_*` wins over the `R2_*` aliases). With no
object-store credentials the Supabase `media` bucket is used, so a fresh clone
runs with one env file and nothing else.

Uploads store **keys**, never full URLs, so the read proxy
(`/api/public/media/<key>`) re-resolves existing objects against whichever
backend is live. Health (`/api/public/health`) and the admin console's _System
settings → Storage backend_ card report the active backend and probe its
credentials, so a misconfigured switch is visible instead of silent.

#### Why references survive a switch (and what does not)

A database row that recorded `https://<ref>.supabase.co/storage/v1/object/…`
would break the moment the bucket stopped being Supabase, because the _host_ is
exactly what changes. So nothing stores a vendor URL: posts, profiles, stories,
messages and recordings hold `folder/owner/<upload-id>.ext` (or the equivalent
`/api/public/media/…` path), and `media_objects.path` registers each key.
`mediaKeyFromUrl()` deliberately returns `null` for an absolute `http(s)` URL, so
a provider's public link can never be mistaken for a storable reference. The only
absolute URLs in the database are external by nature (Paystack checkout links,
Google OAuth avatar URLs) and no storage backend can serve them.

What a switch _does_ leave behind is the bytes: objects uploaded while the old
bucket was live only exist there. Two mechanisms cover that:

1. **Read mirror** — the other configured backend is tried on every read, so
   past media keeps rendering immediately after you paste new credentials. It
   needs the _old_ credentials to stay in the environment, and writes still go to
   the active backend only, so the store converges instead of splitting.
2. **Relocation** — _System settings → Storage backend → "Check what's
   missing"_ counts what the active bucket does not have yet, and "Copy legacy
   objects" streams them across under identical keys. Sizes are verified after
   each write; existing objects are never overwritten and nothing is deleted, so
   it is idempotent and interruptible — run it until it reports fully drained
   (`Admin → System settings`, or `relocateLegacyMedia` in
   `src/lib/storage/relocate.server.ts`). Only then is it safe to remove the
   legacy credentials from `.env`.

### Other pluggable resources

| Resource            | Env keys                                                        | Notes                                                                                 |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AI assistant        | `AI_API_KEY`, `AI_GATEWAY_URL`, `AI_TEXT_MODEL`                 | any OpenAI-compatible endpoint; gated by the platform's AI toggle                     |
| Payments            | `PAYSTACK_SECRET_KEY`, `PAYSTACK_CURRENCY`, `PAYSTACK_USD_RATE` | provider redirects are pinned to this deployment's origin                             |
| WebRTC TURN         | `TURN_REST_URL`, `TURN_REST_USERNAME`, `TURN_REST_API_KEY`      | ephemeral credentials minted server-side; blank = STUN-only                           |
| CORS / origin trust | `ALLOWED_API_ORIGINS`                                           | developer API + payment callback allowlist                                            |
| Platform toggles    | `system_settings` table                                         | maintenance mode, registration, AI, Live Spaces — enforced server-side, zero downtime |

## Migrations

`DATABASE_URL` must be a connection that can reach the database. Supabase's
direct `db.*` host is IP-blocked from most networks, so use the session pooler —
the username is `postgres.<project-ref>` with a **dot**, and the region prefix
must match the project's region:

```powershell
$env:DATABASE_URL='postgresql://postgres.<project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres'
npm run db:migrate           # applies pending files, records sha256 checksums
npm run db:migrate:status
```

Applied migrations are **immutable** — the runner rejects checksum drift. To fix
something that shipped, add a new `NNN_description.sql` rather than editing the
old one. RLS policies and grants live in
[`db/migrations/20260924000002_starpace_grants_and_rls.sql`](db/migrations/20260924000002_starpace_grants_and_rls.sql)
and its follow-ups.

### Engagement tallies are the only number the UI reads

`posts.like_count`, `posts.repost_count` and `stories.likes_count` are maintained
by AFTER triggers over `likes` / `reposts` / `story_likes`, and they are what
every feed, post page and story renders. A like toggle must therefore report the
column back (`readTally()` in [`src/lib/api-client.ts`](src/lib/api-client.ts))
and not `COUNT(*)` the join table itself: two formulas that agree only while the
trigger has run for every row. If they disagree, the heart fills in and the
number beside it moves the wrong way. `20260929000092_recount_engagement_counters.sql`
heals rows that had already drifted and adds BEFORE UPDATE guards that recompute
a tally whenever anything changes it — the trigger's honest write lands
unchanged, a hand-written number does not.

## Connecting the production domain (spaces1.com)

Redirect URLs are built from `window.location.origin` at runtime
(`src/routes/auth.tsx` → `authCallbackUrl()`), so the same build serves
localhost, previews and `spaces1.com`. Nothing in the repo holds the domain —
what it needs are entries on the provider side:

**Supabase → Authentication → URL Configuration**

- Site URL: `https://spaces1.com`
- Additional Redirect URLs (comma-separated list):

```text
https://spaces1.com/oauth/callback,https://www.spaces1.com/oauth/callback,https://spaces1.com/auth,https://www.spaces1.com/auth,http://localhost:8080/oauth/callback,http://localhost:8080/auth
```

**Supabase → Authentication → Providers → Google** — Authorized JavaScript
origins include `https://spaces1.com` and `https://www.spaces1.com`.

One thing to understand before expecting the sign-in screen to look branded:
Google's "Choose an account to continue to …" label is derived from the host of
the **OAuth redirect URI**, which is Supabase's own auth endpoint
(`https://<project-ref>.supabase.co/auth/v1/callback`) — never from the
`redirectTo` this app sends. Changing that label means changing the auth host:

1. Supabase → Settings → **Custom hostname** (Pro plan, add-on; `CNAME` only and
   **subdomains only**, so `auth.spaces1.com` works and apex `spaces1.com` does
   not). Once active, Supabase Auth advertises the new host as its callback URL,
   so the consent screen reads `auth.spaces1.com` and signup/magic-link/email
   templates stop mentioning `supabase.co`. Add
   `https://auth.spaces1.com/auth/v1/callback` to the Google client's Authorized
   redirect URIs **alongside** the old `<project-ref>.supabase.co` one, then
   optionally point `SUPABASE_URL` at the custom hostname (both work
   interchangeably for everything except Auth, which switches immediately).
2. Separately, fill in Google Auth Platform → **Branding** and request
   **Verification** so the screen shows the Spaces1 name and logo instead of the
   raw host. Only these two retire `supabase.co`; no env change on our side does.

**Paystack → Settings → Domains & Redirects**

- `https://spaces1.com` (and `https://www.spaces1.com`) as the integration
  domain; `https://spaces1.com/billing/callback` as an allowed redirect.
- Webhook URL: `https://spaces1.com/api/public/paystack/webhook` (server-side
  route, signature-verified — a tip or subscription that is paid for but never
  recorded is worse than a slow checkout).
- Live secret `sk_live_…`, public key `pk_live_…`, `APP_ENV=production`.

**Server env for the deployed app**

```env
APP_ENV=production
ALLOWED_API_ORIGINS=https://spaces1.com,https://www.spaces1.com
```

CSP already allows the Supabase host, Paystack and `https:` images/media, so an
R2/B2/Spaces public bucket domain (optional `S3_PUBLIC_BASE_URL` +
`MEDIA_PUBLIC_CDN=true`) needs no CSP change.

## Layout

```text
db/migrations/      forward-only SQL (schema, RLS, guards, triggers)
drizzle/schema.ts   typed schema mirror used by server code
src/routes/         file-based routes + /api/** server handlers
src/components/     social/ (app UI), admin/, calls/, site/, ui/ ( primitives in use)
src/lib/            *.functions.ts = server fns, *.server.ts = server-only
src/integrations/   Supabase clients + auth middleware
tests/              Vitest unit tests (storage provider, media signing, SSRF, money)
```

Two conventions worth knowing before editing:

- A module ending in `.server.ts` may import secrets; `.functions.ts` files are
  reachable from the client bundle, so they import server modules **lazily
  inside handlers**.
- Subsystem availability is enforced in the database (trigger guards raising
  `PT503`/`PT403`) as well as in middleware, so a stale client can never write
  past a paused toggle.

## Working notes

> Port/clone audit: run a wide audit, fix everything, create missing/unfinished
> features, fix bugs, improve design and UX, and keep performance and
> responsiveness complete. See [`roadmap.md`](roadmap.md) for the milestone
> tracker.

## Repository sync note

This repo is connected to a visual editor (`AGENTS.md`,
`.lovable/project.json`). Avoid rewriting published git history — no force
pushes, rebases or amends of pushed commits — because that rewrites history on
the editor's side.
