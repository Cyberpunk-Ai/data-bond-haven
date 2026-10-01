/**
 * Server-only environment contract.
 *
 * The single place the server reads `process.env`. Every value is validated
 * once, lazily (so importing this module during a build/prerender never throws
 * — only the first runtime *access* of a missing required secret does, which is
 * the fail-fast behaviour we want at request/boot time, not bundle time).
 *
 * Rules this file enforces (see remediation plan §3):
 *   • no `BACKEND_*` / `LOVABLE_*` aliases — those Lovable-injected names are
 *     gone; canonical `SUPABASE_*` / `AI_*` only.
 *   • a required secret that is absent produces a loud, specific error naming
 *     the key, instead of a silent `""` fallback that weakens crypto or auth.
 *
 * Object storage is intentionally NOT modelled here: the credentials differ per
 * backend (R2, B2, Spaces, MinIO, S3, or the Supabase bucket) and the platform
 * must still boot when a store has not been pointed at yet, so that contract is
 * owned by the adapter itself — see `src/lib/storage/s3.server.ts`.
 */

let cached: ServerEnv | undefined;

const DEFAULT_GEOCODER_URL = "https://nominatim.openstreetmap.org/search";

type ServerEnv = {
  appEnv: string;
  isProduction: boolean;
  cspReportOnly: boolean;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
  ai: { apiKey?: string; gatewayUrl?: string; textModel: string };
  paystack: { secretKey: string; currency: string; usdRate: number };
  apiKeyPepper: string;
  cronSecret: string;
  webhookMaxAttempts: number;
  allowedApiOrigins: string[];
  turn: { restUrl?: string; username?: string; apiKey?: string; ttlSeconds: number };
  geocoder: { url: string; userAgent: string };
};

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function need(name: string): string {
  const value = read(name);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable "${name}". Set it in your deployment's secret store (Cloudflare Worker secret / .dev.vars locally).`,
    );
  }
  return value;
}

function numOr(name: string, fallback: number): number {
  const parsed = Number(read(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstText(...names: string[]): string {
  for (const name of names) {
    const value = read(name);
    if (value) return value;
  }
  return "";
}

function build(): ServerEnv {
  const appEnv = read("APP_ENV") ?? read("NODE_ENV") ?? "development";
  const isProduction = appEnv === "production";

  const pepper = read("API_KEY_PEPPER") ?? "";
  if (isProduction && pepper.length < 32) {
    throw new Error(
      "API_KEY_PEPPER must be a strong secret of at least 32 characters in production (`openssl rand -hex 32`).",
    );
  }

  const paystackSecret = read("PAYSTACK_SECRET_KEY");
  if (isProduction && paystackSecret && !paystackSecret.startsWith("sk_live_")) {
    throw new Error(
      "PAYSTACK_SECRET_KEY does not look like a live key in production (expected sk_live_…).",
    );
  }

  // Identity for outbound lookups that a browser could not attest to itself
  // (see the geocoder below): who is calling, and how the other side can reach us.
  const geoName = firstText("APP_NAME", "VITE_APP_NAME") || "Spaces1";
  const geoContact = firstText("SUPPORT_EMAIL", "VITE_SUPPORT_EMAIL");

  return {
    appEnv,
    isProduction,
    cspReportOnly: read("CSP_REPORT_ONLY") === "true" || read("CSP_REPORT_ONLY") === "1",
    supabaseUrl: need("SUPABASE_URL"),
    supabasePublishableKey: need("SUPABASE_PUBLISHABLE_KEY"),
    supabaseServiceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    ai: {
      apiKey: read("AI_API_KEY"),
      gatewayUrl: read("AI_GATEWAY_URL"),
      textModel: read("AI_TEXT_MODEL") ?? "gpt-4o-mini",
    },
    paystack: {
      // Callers already guard on an empty key; not hard-required so partial /
      // test environments that don't use payments can still boot.
      secretKey: read("PAYSTACK_SECRET_KEY") ?? "",
      currency: read("PAYSTACK_CURRENCY") ?? "KES",
      usdRate: numOr("PAYSTACK_USD_RATE", 130),
    },
    apiKeyPepper: pepper,
    cronSecret: read("CRON_SECRET") ?? "",
    webhookMaxAttempts: numOr("WEBHOOK_MAX_ATTEMPTS", 6),
    allowedApiOrigins: (read("ALLOWED_API_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    // Ephemeral TURN (RFC 5766). Credentials are minted server-side per request
    // and handed to the browser short-lived — the shared secret never ships in
    // the bundle (plan §S4). Unset => STUN-only fallback (calls still connect
    // on the open internet, just not behind symmetric NATs).
    turn: {
      restUrl: read("TURN_REST_URL"),
      username: read("TURN_REST_USERNAME"),
      apiKey: read("TURN_REST_API_KEY"),
      ttlSeconds: numOr("TURN_TTL_SECONDS", 3600),
    },
    // Composer location labels. The lookup runs server-side (lib/geocoder.server.ts)
    // so the browser never needs a second origin in the CSP's connect-src, and the
    // outbound request can carry the identifying User-Agent OpenStreetMap's usage
    // policy asks for. VITE_GEOCODER_URL is still read so deployments that only
    // set the old browser variable keep working.
    geocoder: {
      url: firstText("GEOCODER_URL", "VITE_GEOCODER_URL") || DEFAULT_GEOCODER_URL,
      userAgent: `${geoName}/1.0 (post location labels${geoContact ? `; ${geoContact}` : ""})`,
    },
  };
}

/** Access the validated server env. Throws on first use if a required secret is unset. */
export function env(): ServerEnv {
  if (!cached) cached = build();
  return cached;
}

/** Reset the memoised config — test-only seam. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
