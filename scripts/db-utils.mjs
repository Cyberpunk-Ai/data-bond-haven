// Shared helpers for the db migrate/backup/restore scripts. No dependencies
// beyond node built-ins and the `postgres` package the migrations already use.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read .env into an object; real process.env entries win (pooler overrides). */
export function loadEnv() {
  const env = {};
  for (const file of [".env", ".dev.vars"]) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (env[m[1]] === undefined) env[m[1]] = value;
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** Filesystem-safe timestamp: 2026-09-29T14-30-05 */
export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export const storageKey = (env) => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";

/**
 * Many Supabase projects resolve `db.<ref>.supabase.co` to AAAA only. That is
 * fine on a dual-stack network and unreachable on a machine without global
 * IPv6, which is why every db script can be pointed at the IPv4 session pooler
 * instead (`--pooler`). The pooler is issued by Supabase's own private CA, so
 * the system trust store rejects it; rather than turning verification off we
 * anchor it to the captured root and keep the normal chain + hostname checks.
 */
export const POOLER_CA_PATH = join(repoRoot, "scripts", "supabase-pooler-root.pem");

// Tried in order; `POOLER_HOST` / `POOLER_REGION` override these entirely.
const DEFAULT_POOLER_REGIONS = ["aws-1-eu-west-1", "aws-0-eu-west-1"];

function poolerHosts(env) {
  if (env.POOLER_HOST) return [env.POOLER_HOST];
  if (env.POOLER_REGION) return [`${env.POOLER_REGION}.pooler.supabase.com`];
  return DEFAULT_POOLER_REGIONS.map((r) => `${r}.pooler.supabase.com`);
}

/** postgres() connection fields for one route: the raw URL, or the same
 * credentials rebuilt against a pooler host. Only the pooler needs fields,
 * because postgres.js takes a plain URL string as its first argument and does
 * NOT recognise a `url` key inside the options object. */
function routeFields(env, poolerHost) {
  if (!poolerHost) return null;
  const parsed = new URL(env.DATABASE_URL);
  const ref = parsed.hostname.split(".")[1];
  if (!ref) die(`Cannot read a project ref out of ${parsed.hostname} to build a pooler host.`);
  if (!existsSync(POOLER_CA_PATH)) {
    die(
      `${POOLER_CA_PATH} is missing — the pooler's CA root has to be captured before --pooler can verify TLS.`,
    );
  }
  return {
    host: poolerHost,
    // 5432 is session mode (a 1:1 connection): transaction mode pools statements
    // in a way that breaks multi-statement DDL, and migrations are DDL.
    port: Number(env.POOLER_PORT ?? 5432),
    database: parsed.pathname.replace(/^\//, "") || "postgres",
    user: parsed.username.includes(".") ? parsed.username : `postgres.${ref}`,
    password: decodeURIComponent(parsed.password),
    ssl: {
      ca: readFileSync(POOLER_CA_PATH, "utf8"),
      rejectUnauthorized: true,
      servername: poolerHost,
    },
  };
}

/**
 * A connection failure can arrive as an AggregateError with an empty `message`
 * (one leaf per DNS answer), so read the leaves too — otherwise the runner
 * prints "connection failed:" and nothing about why.
 */
function errorReason(err) {
  if (!err) return "unknown error";
  const leaves = (err.errors ?? []).map((e) => e?.message).filter(Boolean);
  const parts = [err.message, ...leaves].filter(Boolean);
  // The code is usually already inside the message (`getaddrinfo ENOTFOUND x`),
  // so only append it when it would add information.
  const joined = parts.join(" · ");
  if (err.code && !joined.includes(err.code)) parts.push(err.code);
  if (err.cause?.message) parts.push(err.cause.message);
  return (parts.filter(Boolean).join(" · ") || String(err)).slice(0, 220);
}

/**
 * Open a connection. `pooler: true` routes through Supabase's IPv4 pooler,
 * trying each candidate region until one answers; the default is the direct
 * host from DATABASE_URL. Returns a live `postgres` handle (one round-trip is
 * used to prove it) so callers never receive an object that fails later.
 */
export async function connect(env, { pooler = false, ...overrides } = {}) {
  if (!env.DATABASE_URL) die("DATABASE_URL is not set (checked shell env and .env).");
  const hosts = pooler ? poolerHosts(env) : [null];
  let lastError;
  for (const host of hosts) {
    const fields = routeFields(env, host);
    const target = fields ?? env.DATABASE_URL;
    const sql = postgres(target, { max: 1, connect_timeout: 20, ...overrides });
    try {
      await sql`select 1`;
      if (host) {
        console.log(
          `connected via the IPv4 session pooler ${host}:${fields.port}` +
            ` (TLS verified against scripts/supabase-pooler-root.pem)`,
        );
      }
      return sql;
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => {});
      const reason = errorReason(err);
      if (hosts.length > 1)
        console.warn(`  ${host} did not answer (${reason}), trying the next region…`);
      else console.error(`  connection failed: ${reason}`);
    }
  }
  const reason = errorReason(lastError);
  const hint = pooler
    ? `Set POOLER_HOST / POOLER_REGION / POOLER_PORT if this project's pooler is elsewhere.`
    : /127\.0\.0\.1|::1|localhost/.test(reason)
      ? `The connection string was not honoured (it tried localhost).`
      : `A host that only answers AAAA is unreachable without global IPv6 — retry with --pooler.`;
  die(`Could not connect to the database (${reason}). ${hint}`);
}

/** Authenticated call to the project's REST/storage API with the secret key. */
export async function apiFetch(env, path, init = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base) die("SUPABASE_URL is not set");
  const key = storageKey(env);
  if (!key) die("SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY is not set");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.body && typeof init.body !== "string" && !(init.body instanceof Uint8Array)
        ? { "Content-Type": "application/json" }
        : typeof init.body === "string" && init.body.startsWith("{")
          ? { "Content-Type": "application/json" }
          : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : new Uint8Array(await res.arrayBuffer());
}
