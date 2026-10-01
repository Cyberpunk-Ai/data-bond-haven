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
//   node scripts/db-migrate.mjs --pooler      reach the database through Supabase's
//                                             IPv4 session pooler (see db-utils.mjs:
//                                             the direct host is often IPv6-only and
//                                             unreachable without global IPv6)
//
// Reads DATABASE_URL from the environment, .env, or .dev.vars. Each applied
// file is stored with a sha256 checksum so an accidental edit to an already
// shipped migration is caught rather than silently ignored.
//
// After any apply/baseline the runner sends `NOTIFY pgrst, 'reload schema'`
// so Supabase's PostgREST drops its cached schema immediately — without it,
// new columns/functions stay invisible (PGRST204 / PGRST202) until the API
// layer notices the change on its own.
// =============================================================================
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadEnv, connect, die, repoRoot } from "./db-utils.mjs";
import { duplicateVersions, sortMigrationFiles, unresolvedPins } from "./migration-order.mjs";

const migrationsDir = join(repoRoot, "db", "migrations");

const args = new Set(process.argv.slice(2));
const MODE = args.has("--status")
  ? "status"
  : args.has("--dry-run")
    ? "dry-run"
    : args.has("--baseline")
      ? "baseline"
      : "apply";

async function listMigrationFiles() {
  // Numeric-aware, with pins for the files whose prefix lies about where they
  // belong: a plain `.sort()` puts `…0000011_…` before `…000001_…`, which
  // replays history out of order and breaks a fresh database. See
  // scripts/migration-order.mjs; tests/migration-order.test.ts pins it.
  const names = sortMigrationFiles(
    (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")),
  );
  for (const pin of unresolvedPins(names)) {
    console.warn(
      `! ${pin.file} is pinned to run after ${pin.after}, but one of them is missing ` +
        `from db/migrations — it will run wherever its prefix puts it.`,
    );
  }
  const clashes = duplicateVersions(names);
  for (const group of clashes) {
    console.warn(
      `! ${group.length} migrations share the version prefix ${group[0].match(/^(\d+)/)[0]}: ` +
        `${group.join(", ")} — they will apply in filename order.`,
    );
  }
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

async function reloadPostgrestSchema(sql) {
  try {
    await sql`select pg_notify('pgrst', 'reload schema')`;
    console.log("PostgREST schema cache reload notified.");
  } catch (err) {
    // Never fail a migration because the notify didn't land.
    console.warn("Could not notify PostgREST to reload schema:", err?.message ?? err);
  }
}

async function main() {
  const env = loadEnv();
  if (!env.DATABASE_URL) die("DATABASE_URL is not set (checked env, .env, .dev.vars).");

  const files = await listMigrationFiles();
  const sql = await connect(env, {
    pooler: args.has("--pooler"),
    onnotice: () => {},
  });

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
      console.log(
        `\nRecorded ${pending.length} existing migrations as applied without running them.`,
      );
      await reloadPostgrestSchema(sql);
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
      await reloadPostgrestSchema(sql);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
