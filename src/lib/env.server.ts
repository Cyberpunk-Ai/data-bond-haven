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
 */

let cached: ServerEnv | undefined;

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
  r2: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    publicBaseUrl?: string;
  };
  turn: { restUrl?: string; username?: string; apiKey?: string; ttlSeconds: number };
  media: { imageMb: number; videoMb: number; audioMb: number };
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
    r2: {
      accountId: read("R2_ACCOUNT_ID"),
      accessKeyId: read("R2_ACCESS_KEY_ID"),
      secretAccessKey: read("R2_SECRET_ACCESS_KEY"),
      bucket: read("R2_BUCKET"),
      publicBaseUrl: read("R2_PUBLIC_BASE_URL"),
    },
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
    media: {
      imageMb: numOr("MEDIA_MAX_IMAGE_MB", 25),
      videoMb: numOr("MEDIA_MAX_VIDEO_MB", 100),
      audioMb: numOr("MEDIA_MAX_AUDIO_MB", 100),
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
