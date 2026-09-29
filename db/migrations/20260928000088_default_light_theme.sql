-- ============================================================================
-- The product standard is a LIGHT default theme for everyone — landing pages
-- and the social app alike. The JS side already ships light defaults
-- (DEFAULT_THEME / preferences DEFAULTS / :root tokens), but the core schema
-- seeded user_preferences.theme with NOT NULL DEFAULT 'dark', so any account
-- whose row predates explicit choosing — or was created through a path that
-- leaned on the column default — is pinned to dark and the account preference
-- then overrides the light default on every device.
--
-- Flip the column default, restate dark rows to light, and let people who
-- genuinely want dark pick it in Settings (that explicit pick now persists as
-- 'dark' and is respected).
-- ============================================================================

alter table public.user_preferences
  alter column theme set default 'light';

update public.user_preferences
   set theme = 'light'
 where theme = 'dark';
