/**
 * Single source of truth for environment-swappable configuration.
 *
 * Every tunable (brand, limits, feature flags, storage bucket, AI model,
 * pagination) reads from `import.meta.env.VITE_*` with a safe default, so the
 * same build can be re-pointed at a different deployment without code edits.
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
    supportEmail: str("VITE_SUPPORT_EMAIL", "support@spaces1.app"),
  },
  storage: {
    bucket: str("VITE_MEDIA_BUCKET", "media"),
    maxUploadMb: num("VITE_MAX_UPLOAD_MB", 25),
  },
  ai: {
    textModel: str("VITE_AI_TEXT_MODEL", "google/gemini-2.5-flash"),
    imageModel: str("VITE_AI_IMAGE_MODEL", "google/gemini-2.5-flash-image"),
  },
  feed: {
    pageSize: num("VITE_FEED_PAGE_SIZE", 20),
    maxPageSize: num("VITE_FEED_MAX_PAGE_SIZE", 100),
    storyTtlHours: num("VITE_STORY_TTL_HOURS", 24),
  },
  limits: {
    postLength: num("VITE_MAX_POST_LENGTH", 500),
    storyTextLength: num("VITE_MAX_STORY_LENGTH", 220),
  },
  geocoder: {
    url: str("VITE_GEOCODER_URL", "https://nominatim.openstreetmap.org/search"),
  },
  realtime: {
    turnUrl: str("VITE_TURN_URL", ""),
    turnUsername: str("VITE_TURN_USERNAME", ""),
    turnCredential: str("VITE_TURN_CREDENTIAL", ""),
    maxMeshSpeakers: num("VITE_SPACES_MESH_MAX", 8),
    sfuProvider: str("VITE_SPACES_SFU_PROVIDER", ""),
    sfuUrl: str("VITE_SPACES_SFU_URL", ""),
  },
  features: {
    stories: bool("VITE_FEATURE_STORIES", true),
    spaces: bool("VITE_FEATURE_SPACES", true),
    messaging: bool("VITE_FEATURE_MESSAGING", true),
    tipping: bool("VITE_FEATURE_TIPPING", true),
    ai: bool("VITE_FEATURE_AI", true),
    developerPortal: bool("VITE_FEATURE_DEVELOPER_PORTAL", true),
    workspaces: bool("VITE_FEATURE_WORKSPACES", true),
  },
} as const;

export type AppConfig = typeof appConfig;

/** Convenience helper so components can branch on a flag by name. */
export function isFeatureEnabled(feature: keyof AppConfig["features"]): boolean {
  return appConfig.features[feature];
}
