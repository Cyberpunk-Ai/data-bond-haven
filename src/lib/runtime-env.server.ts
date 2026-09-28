/**
 * Runtime env hydration for the standalone node-server build.
 *
 * `npm run build` + `npm start` runs `.output/server/index.mjs` (Nitro
 * node-server preset). That runtime reads `process.env` only from the real
 * shell environment — it never parses `.env` / `.dev.vars`. In Vite dev the
 * same mirroring happens in `vite.config.ts`, so server modules
 * (`client.server.ts`, the media proxy, `env.server.ts`) see the values.
 * Under `npm start` they would not, and every server-side Supabase call
 * (media downloads, uploads, service-role reads) would fail — surfacing to
 * users as broken images / 404 media.
 *
 * This bridges the gap: at server boot we mirror `.env` (and `.dev.vars`) into
 * `process.env`, never overwriting a value the shell already provided (real
 * env always wins, so production secret stores take precedence). It is
 * dependency-free and degrades silently on runtimes without `node:fs` (e.g. a
 * Cloudflare Worker deploy), where the platform already injects the env.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const FILES = [".env", ".dev.vars"];

let loaded = false;

function applyFile(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A value already set by the real environment always wins.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Populate `process.env` from local dotenv files. Idempotent; safe to call first. */
export function loadRuntimeEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    for (const file of FILES) {
      const path = join(cwd(), file);
      if (existsSync(path)) applyFile(readFileSync(path, "utf8"));
    }
  } catch {
    // No filesystem access in this runtime — the platform must provide env.
  }
}
