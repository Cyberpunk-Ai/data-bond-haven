#!/usr/bin/env node
// =============================================================================
// Idempotent SQL migration runner for db/migrations/*.sql.
//
// Replaces scripts/db-migrate.sh, which re-applied every file on every run
// (no tracking table → duplicate-object failures) and required bash + psql
// (unavailable on Windows). This runs on plain `node`, cross-platform.
//
//   node scripts/db-migrate.mjs              apply pending migrations
//   node scripts/db-migrate.mjs --status      list applied vs pending
//   node scripts/db-migrate.mjs --dry-run     show what would apply, change nothing
//   node scripts/db-migrate.mjs --baseline    record all files as applied, run nothing
//                                             (adopt an existing database once)
//
// Reads DATABASE_URL from the environment, .env, or .dev.vars. Each applied
// file is stored with a sha256 checksum so an accidental edit to an already
// shipped migration is caught rather than silently ignored.
// =============================================================================
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const migrationsDir = join(repoRoot, "db", "migrations");

const args = new Set(process.argv.slice(2));
const MODE = args.has("--status")
  ? "status"
  : args.has("--dry-run")
    ? "dry-run"
    : args.has("--baseline")
      ? "baseline"
      : "apply";

function loadDotEnv() {
  for (const file of [".env", ".dev.vars"]) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function listMigrationFiles() {
  const names = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(migrationsDir, name), "utf8");
      return { version: name.replace(/\.sql$/, ""), name, sql, checksum: sha256(sql) };
    }),
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const TRACKING_DDL = `
  create table if not exists public.schema_migrations (
    version    text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  );
`;

async function main() {
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (checked env, .env, .dev.vars).");
    process.exit(1);
  }

  const files = await listMigrationFiles();
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql.unsafe(TRACKING_DDL);
    const applied = await sql`select version, checksum from public.schema_migrations`;
    const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

    // Detect drift: a shipped file whose contents changed after being applied.
    for (const f of files) {
      const prior = appliedMap.get(f.version);
      if (prior && prior !== f.checksum && !args.has("--force")) {
        console.error(
          `✗ Checksum drift on ${f.name}: it was applied with a different checksum. ` +
            `Never edit a shipped migration — add a new one. (--force to override)`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const pending = files.filter((f) => !appliedMap.has(f.version));

    if (MODE === "status") {
      for (const f of files) {
        console.log(`${appliedMap.has(f.version) ? "✓" : "·"} ${f.name}`);
      }
      console.log(`\n${appliedMap.size} applied, ${pending.length} pending.`);
      return;
    }

    if (MODE === "baseline") {
      if (pending.length === 0) {
        console.log("Nothing to baseline — every file is already recorded.");
        return;
      }
      for (const f of pending) {
        await sql`insert into public.schema_migrations (version, checksum) values (${f.version}, ${f.checksum})
          on conflict (version) do update set checksum = excluded.checksum`;
        console.log(`baselined ${f.name} (not executed)`);
      }
      console.log(`\nRecorded ${pending.length} existing migrations as applied without running them.`);
      return;
    }

    if (pending.length === 0) {
      console.log("Database is up to date — no pending migrations.");
      return;
    }

    for (const f of pending) {
      if (MODE === "dry-run") {
        console.log(`would apply ${f.name}`);
        continue;
      }
      console.log(`applying ${f.name} …`);
      // postgres.js runs multi-statement strings inside a single transaction by
      // default (simple query protocol); record the version atomically with it.
      await sql.begin(async (tx) => {
        await tx.unsafe(f.sql);
        await tx`insert into public.schema_migrations (version, checksum) values (${f.version}, ${f.checksum})`;
      });
      console.log(`  ✓ ${f.name}`);
    }

    if (MODE === "dry-run") {
      console.log(`\n${pending.length} migration(s) would be applied (dry run — nothing changed).`);
    } else {
      console.log(`\nApplied ${pending.length} migration(s).`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
