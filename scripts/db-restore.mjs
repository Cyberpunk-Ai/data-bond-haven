#!/usr/bin/env node
// =============================================================================
// Restore a backup made by scripts/db-backup.mjs (schema + data + storage).
//
//   npm run db:restore                      validate the LATEST backup (safe:
//                                           applies schema in a transaction
//                                           that is rolled back; changes
//                                           NOTHING)
//   npm run db:restore backups/<stamp>      validate a specific backup
//   npm run db:restore ... -- --yes         ACTUALLY restore: drops the public
//                                           schema, recreates it from
//                                           schema.sql, reloads all table data,
//                                           re-syncs sequences, re-uploads
//                                           storage objects
//   flags: --skip-schema  --skip-data  --skip-storage  (combine with --yes)
//   flag:  --pooler  reach the database through Supabase's IPv4 session pooler,
//          for machines that cannot route to the IPv6-only direct host
//
// DESTRUCTIVE WARNING: --yes replaces the current public schema wholesale.
// The database password / host come from DATABASE_URL (shell env wins over
// .env), same as the migrate script.
// =============================================================================
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, connect, die, apiFetch, repoRoot } from "./db-utils.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const skipSchema = args.includes("--skip-schema");
const skipData = args.includes("--skip-data");
const skipStorage = args.includes("--skip-storage");

const env = loadEnv();

// Resolve the backup folder: explicit arg, else newest dir under backups/.
function latestBackupDir() {
  const root = join(repoRoot, "backups");
  if (!existsSync(root)) die("No backups/ folder — run npm run db:backup first.");
  const dirs = readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort();
  if (!dirs.length) die("backups/ is empty.");
  return join(root, dirs[dirs.length - 1]);
}
const dir = args.find((a) => !a.startsWith("--"))
  ? join(
      repoRoot,
      args.find((a) => !a.startsWith("--")),
    )
  : latestBackupDir();
if (!existsSync(join(dir, "manifest.json"))) die(`Not a backup folder: ${dir}`);

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const schemaSql = existsSync(join(dir, "schema.sql"))
  ? readFileSync(join(dir, "schema.sql"), "utf8")
  : null;

console.log(`Backup:  ${dir.replace(repoRoot, ".")}`);
console.log(`Created: ${manifest.created}`);
console.log(`Tables:  ${manifest.tables.length}, buckets: ${manifest.buckets.length}`);
if (!yes) {
  console.log(`Mode:    VALIDATE ONLY (nothing changes). Add --yes to restore.`);
} else {
  console.log(
    `Mode:    RESTORE (${[!skipSchema && "schema", !skipData && "data", !skipStorage && "storage"].filter(Boolean).join(" + ") || "nothing"})`,
  );
}

const sql = await connect(env, {
  pooler: args.includes("--pooler"),
  idle_timeout: 60,
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
async function applySchemaScript(prelude) {
  // One implicit transaction: the whole file commits or rolls back together.
  await sql.unsafe(`begin;\n${prelude}\n${schemaSql}\ncommit;`);
}

if (schemaSql && !skipSchema) {
  const prelude = yes
    ? `drop schema if exists public cascade; create schema public;
       grant usage on schema public to anon, authenticated, service_role;
       grant all on schema public to postgres;`
    : ""; // validation runs inside its own savepoint-style txn below
  if (yes) {
    console.log("Applying schema.sql (public schema dropped & recreated)…");
    await applySchemaScript(prelude);
  } else {
    console.log("Validating schema.sql in a throwaway schema (rolled back, nothing changes)…");
    // Rewrite the dump into a scratch namespace so validation can run against
    // the live server without colliding with the real public schema.
    const tmp = `bkcheck_${Date.now() % 10000000}`;
    const script =
      `create schema ${tmp};\nset search_path to ${tmp}, public, extensions;\n` +
      schemaSql
        .replace(
          /^set search_path to public[^\n]*$/m,
          `set search_path to ${tmp}, public, extensions;`,
        )
        .replace(/\bpublic\./g, `"${tmp}".`);
    try {
      // Run every statement, then roll back — proves the DDL applies cleanly
      // without touching the live schema.
      await sql.begin(async (tx) => {
        await tx.unsafe(script);
        throw new Error("__rollback__");
      });
    } catch (e) {
      if (String(e?.message) !== "__rollback__") {
        console.error(`schema.sql FAILED to apply: ${String(e.message).slice(0, 400)}`);
        await sql.end();
        process.exit(1);
      }
    }
    console.log("schema.sql applies cleanly.");
  }
} else if (!schemaSql) {
  console.warn("No schema.sql in this backup — skipping schema.");
}

// ---------------------------------------------------------------------------
// Data (only meaningful right after a schema apply; validation mode just
// counts the files)
// ---------------------------------------------------------------------------
const dataDir = join(dir, "data");
if (existsSync(dataDir)) {
  const files = manifest.tables.filter(
    (t) => t.rows != null && existsSync(join(dataDir, `${t.name}.json`)),
  );
  if (!yes) {
    const total = files.reduce((s, t) => s + (t.rows || 0), 0);
    console.log(`Data check: ${files.length} table files present, ${total} rows expected.`);
  } else if (!skipData) {
    // Insert parents before children (FK topo order; break cycles by retrying).
    const byName = Object.fromEntries(files.map((t) => [t.name, t]));
    const deps = {};
    for (const t of files) deps[t.name] = new Set();
    for (const fk of manifest.fks) if (byName[fk.from] && byName[fk.to]) deps[fk.from].add(fk.to);

    const order = [];
    const placed = new Set();
    let remaining = files.map((t) => t.name);
    while (remaining.length) {
      const pass = remaining.filter((n) =>
        [...deps[n]].every((d) => placed.has(d) || remaining.indexOf(d) === -1 || deps[d].has(n)),
      );
      const picked = pass.length ? pass : [remaining[0]]; // cycle -> force one
      for (const n of picked) {
        order.push(n);
        placed.add(n);
      }
      remaining = remaining.filter((n) => !placed.has(n));
    }

    console.log("Restoring data…");
    // Truncate deepest-first so FKs don't block, then insert in FK order.
    for (const name of [...order].reverse()) {
      await sql.unsafe(`truncate table public."${name}" restart identity`);
    }
    for (const name of order) {
      const rows = JSON.parse(readFileSync(join(dataDir, `${name}.json`), "utf8"));
      const cols = Object.keys(rows[0] || {});
      if (!cols.length) continue;
      const colSql = cols.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
      let done = 0;
      while (done < rows.length) {
        const chunk = rows.slice(done, done + 400);
        const values = chunk.map((r) => `(${cols.map(() => "?").join(", ")})`).join(",\n");
        const params = chunk.flatMap((r) =>
          cols.map((c) => {
            const v = r[c];
            return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
          }),
        );
        await sql.unsafe(`insert into public."${name}" (${colSql}) values\n${values}`, params);
        done += chunk.length;
      }
      console.log(`  ${name}: ${rows.length} rows`);
    }

    // Re-sync sequences that belong to a column to the data we just loaded.
    for (const s of manifest.sequences || []) {
      if (!s.table || !s.column) continue;
      try {
        await sql.unsafe(
          `select setval('public."${s.name}"', coalesce((select max("${s.column}") from public."${s.table}"), ${s.start}), (select count(*) from public."${s.table}") > 0)`,
        );
      } catch (e) {
        console.warn(`  sequence ${s.name} skipped: ${String(e.message).slice(0, 80)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Storage (downloaded files -> re-upload; buckets must be creatable by key)
// ---------------------------------------------------------------------------
const storageDir = join(dir, "storage");
if (!skipStorage && existsSync(storageDir)) {
  if (!yes) {
    const objs = manifest.buckets.reduce((s, b) => s + (b.objects || []).length, 0);
    const onDisk = objs > 0 && existsSync(join(storageDir, manifest.buckets[0].name));
    console.log(
      `Storage check: ${objs} object(s) listed${onDisk ? ", files present" : ", files NOT downloaded (listing-only backup)"}.`,
    );
  } else {
    const MIME = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".json": "application/json",
    };

    let uploaded = 0;
    let failed = 0;
    for (const bucket of manifest.buckets) {
      const bdir = join(storageDir, bucket.name);
      if (!existsSync(bdir)) continue;
      // Ensure the bucket exists.
      try {
        await apiFetch(env, "/storage/v1/bucket", {
          method: "POST",
          body: JSON.stringify({ id: bucket.name, name: bucket.name, public: bucket.public }),
        });
      } catch {
        /* exists */
      }
      for (const key of bucket.objects || []) {
        const file = join(bdir, ...key.split("/"));
        if (!existsSync(file)) continue;
        const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
        try {
          const body = new Uint8Array(readFileSync(file));
          await apiFetch(env, `/storage/v1/object/${bucket.name}/${key}`, {
            method: "POST",
            headers: {
              "Content-Type": MIME[ext] || "application/octet-stream",
              "x-upsert": "true",
            },
            body,
          });
          uploaded++;
        } catch (e) {
          failed++;
          if (failed <= 5)
            console.warn(`  storage ${bucket.name}/${key}: ${String(e.message).slice(0, 120)}`);
        }
      }
    }
    console.log(`Storage: ${uploaded} uploaded, ${failed} failed.`);
  }
} else if (!existsSync(storageDir)) {
  console.log("Storage: no downloaded objects in this backup (listing-only).");
}

// PostgREST must learn about the rebuilt schema.
try {
  await sql.unsafe(`notify pgrst, 'reload schema'`);
} catch {}
await sql.end();

if (!yes) {
  console.log(
    `\nValidation OK. To actually restore:  node scripts/db-restore.mjs "${dir.replace(repoRoot + "\\", "")}" --yes`,
  );
} else {
  console.log("\nRestore complete.");
}
