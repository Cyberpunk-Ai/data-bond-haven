# Roadmap

- [x] Port next branch into project
- [x] Apply migrations to user's Supabase (0000–0008)
- [x] First admin email rule
- [x] Remove Lovable dependencies (Google sign-in, AI endpoint/key via env); .env.example
- [x] Spaces live audio (WebRTC mesh <=8; SFU adapter hook behind env)
- [x] Developer API: hashed keys, /api/public/v1/me + /posts, rate limit, signed webhook queue + dispatcher
- [x] Composer poll question field, validation, typed location suggestions
- [x] About, Terms, Privacy, Contact, Guidelines, polished 404; footer links
- [x] Explore: remove follower counts
- [ ] Team workspace roles (DB-enforced) + invites
- [ ] Settings panels completion
- [ ] Messaging typing/read receipts
- [ ] Feed/admin polish, mobile, speed
- [ ] Payments: Stripe checkout + webhook (blocked: needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PAYSTACK_SECRET_KEY)
- [ ] Schedule webhook dispatcher (blocked: needs published URL + CRON_SECRET)
- [ ] Google sign-in: enable Google provider in Supabase dashboard (user action)
- [ ] Security re-check, full browser test pass
