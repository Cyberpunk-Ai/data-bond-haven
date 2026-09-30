/**
 * Every browser tunable (brand, composer/feed limits, feature flags) reads from
 * `import.meta.env.VITE_*` with a safe default, so the same build can be
 * re-pointed at a different deployment without code edits.
 *
 * Server-only resources (object storage, AI keys and models, TURN, payments,
 * upload caps) are deliberately absent: the browser must never learn them, and
 * the server never trusts a browser-supplied copy. Storage config lives in
 * `src/lib/storage/`, the rest in `src/lib/env.server.ts`.
 */

type EnvRecord = Record<string, string | boolean | undefined>;

const env: EnvRecord = (import.meta.env ?? {}) as EnvRecord;

function str(key: string, fallback: string): string {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  return value === true || value === "true" || value === "1";
}

export const appConfig = {
  brand: {
    name: str("VITE_APP_NAME", "Spaces1"),
    tagline: str("VITE_APP_TAGLINE", "Where creators gather, talk and get paid."),
    supportEmail: str("VITE_SUPPORT_EMAIL", "support@spaces1.com"),
  },
  feed: {
    pageSize: num("VITE_FEED_PAGE_SIZE", 20),
    maxPageSize: num("VITE_FEED_MAX_PAGE_SIZE", 100),
  },
  limits: {
    // Composer cap. The server's own ceiling is higher (post-edit.functions.ts
    // rejects > 5000 chars) so this stays a UX choice, not a security boundary.
    postLength: num("VITE_MAX_POST_LENGTH", 1000),
  },
  geocoder: {
    url: str("VITE_GEOCODER_URL", "https://nominatim.openstreetmap.org/search"),
  },
  realtime: {
    // TURN relay is intentionally absent: the browser never learns a relay URL,
    // username or credential. Ephemeral ICE servers are fetched from the server
    // at call time (see lib/webrtc/ice.ts + turn.functions.ts) — plan §S4.
    maxMeshSpeakers: num("VITE_SPACES_MESH_MAX", 8),
    // Opus ceiling for one voice. 64 kbit/s mono is transparent for speech; the
    // mesh pays for it per uplink, so it stays configurable (useSpaceAudio).
    audioMaxKbps: num("VITE_SPACES_AUDIO_KBPS", 64),
    sfuProvider: str("VITE_SPACES_SFU_PROVIDER", ""),
    sfuUrl: str("VITE_SPACES_SFU_URL", ""),
    recordingMaxMb: num("VITE_SPACES_RECORDING_MAX_MB", 100),
  },
  features: {
    stories: bool("VITE_FEATURE_STORIES", true),
    spaces: bool("VITE_FEATURE_SPACES", true),
    messaging: bool("VITE_FEATURE_MESSAGING", true),
    tipping: bool("VITE_FEATURE_TIPPING", true),
    ai: bool("VITE_FEATURE_AI", true),
    developerPortal: bool("VITE_FEATURE_DEVELOPER_PORTAL", true),
    workspaces: bool("VITE_FEATURE_WORKSPACES", true),
    // "Continue with Google" on the sign-in / sign-up form. Off leaves email +
    // password signup and login exactly as they are; the authentication
    // provider's own Google setting is independent, so people already signed up
    // with Google keep signing in normally.
    googleSignIn: bool("VITE_FEATURE_GOOGLE_SIGNIN", true),
  },
} as const;
