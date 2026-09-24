# Harmony Connect — port, audit, and launch-readiness

This is a large programme of work. It is organised into phases so each one can be
built, checked and signed off before the next begins. Phase 0 must succeed before
anything else is possible.

## Phase 0 — Get the code and the backend in place (blocking)

1. Bring in the existing project from GitHub (`harmony-connect-core`) and adapt it
   to run here. The current project is an empty starter, so this is a full port:
   pages, components, data access and styling all move across and are re-wired to
   this project's routing setup.
2. Connect your existing backend. The keys you pasted let the app talk to your
   Supabase project, but linking it as the project's backend has to be done by you
   in Project Settings → Connectors → Supabase. Until that is done I cannot read
   your tables, access rules or stored files, which most of the audit depends on.
3. Store the secret key, database connection string and (later) the R2 credentials
   in the secure secret store rather than in the code.

Note: the secret key and database password were pasted in plain chat. They should
be regenerated before launch.

## Phase 1 — Data, access rules and security baseline

- Full review of tables, relationships, indexes and constraints; fix integrity gaps.
- Review every access rule (who can read/write what), fix gaps and over-permissive rules.
- Review sign-up/sign-in, roles and admin access.
- Review payment and monetisation paths for security holes.

## Phase 2 — Feed core

- Comments persist and appear live for all users.
- Likes: one per person, counts correct and consistent everywhere.
- Reposts persist and appear on profiles and feeds.
- Stop posts from shifting position while reading.
- Impressions recorded and counted correctly.
- Recommendations driven by real engagement, interests, freshness and relationships.

## Phase 3 — Discovery and profiles

- Explore: Topics and For You genuinely filter; Media opens the full post.
- Search completeness and polish.
- Profile share links open the correct account.
- Profiles load posts, reposts, likes, replies and analytics correctly.
- Post editing works; bookmarks keep full post details.
- Notifications live, clickable and removable without refresh.

## Phase 4 — Messaging and calls

- Messages persist, arrive live, and repeated identical messages are supported.
- Sent / delivered / seen indicators, presence, and sidebar preview with latest
  text or action icon.
- Voice notes, images and media persist.
- Voice and video calling end to end, with live incoming-call alerts, camera,
  screen sharing and smooth transitions between them.

## Phase 5 — Spaces

- Live rooms with hosts seeing and managing all attendees.
- Recording off by default, host-controlled, with a configurable 100MB limit.
- Real replay counts (remove the hardcoded 42) and improved audio handling.

## Phase 6 — Media storage on R2

- A single storage layer used by all media, with secure uploads and access.
- R2 credentials supplied securely and read from the environment.

## Phase 7 — Workspaces, Developer API, Settings

- Pro Team Workspaces: invites, roles, permissions, workspace profiles, and smooth
  switching between personal and workspace context.
- Pro features clearly marked.
- Developer API completed and secured.
- Every Settings option made functional.

## Phase 8 — Copy and content cleanup

- Rename Gemini to AI Sparks.
- Landing figures: 4.5K+ creators, 2.5K+ daily active users, 10K shared posts,
  15K+ daily creator payouts, 5K+ loved by.
- "Watch Demo" becomes "See How It Works"; "Stories/Reels" becomes "Posts/Stories".
- Remove all fake and demo data, including fake replay and analytics numbers.

## Phase 9 — Testing and second audit

- Multi-user testing of each area, plus refresh, logout/login, reconnect,
  simultaneous actions and failure cases.
- Performance, mobile and installable-app behaviour.
- A second full review of security and regressions at the end. Launch-ready is only
  declared after that passes.

## Technical notes

- Stack here is TanStack Start (React 19, Vite, Tailwind v4). If the source repo is
  a plain Vite React SPA with React Router, routing and any server-side pieces must
  be rewritten to file-based routes and server functions; Supabase Edge Functions
  are replaced with server functions or API routes.
- Live updates use Supabase Realtime; calls use WebRTC with a signalling path over
  Realtime, and TURN configuration will be needed for reliability.
- Recording size limits, R2 keys, payment keys and AI keys all come from stored
  secrets, never from code.
- Each phase ends with a build and a browser-driven check of the affected flows.
