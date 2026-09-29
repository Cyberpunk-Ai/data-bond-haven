// Shared helpers for the db backup/restore scripts. No dependencies beyond
// node built-ins and the `postgres` package the migrations already use.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export const storageKey = (env) =>
  env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";

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
