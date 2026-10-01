import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_POSITION_PINS,
  compareNumericStrings,
  compareVersions,
  duplicateVersions,
  migrationVersion,
  sortMigrationFiles,
  unresolvedPins,
} from "../scripts/migration-order.mjs";

/**
 * The runner used to order `db/migrations/*.sql` with a plain string sort. Three
 * published files carry a 15-digit prefix, and `"202609240000011_…"` sorts
 * *before* `"20260924000001_…"`, so a fresh database replayed
 * `alter table public.notifications …` before the core schema created that
 * table. Postgres answered 42P01 and the whole migration run aborted — an
 * environment nobody could provision.
 *
 * The order the runner produces today is the order recorded in the live ledger
 * (`public.schema_migrations.applied_at`), which is the only sequence proven to
 * leave a database in the state production is actually in.
 */
const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// Created by the runner itself (TRACKING_DDL in db-migrate.mjs), not by a file.
const RUNNER_OWNED_TABLES = new Set(["schema_migrations"]);

function repoMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

function positionOf(ordered: string[], part: string): number {
  const index = ordered.findIndex((f) => f.includes(part));
  expect(index, `no migration matches "${part}"`).toBeGreaterThan(-1);
  return index;
}

describe("migration file ordering", () => {
  it("orders a sub-second suffix after the timestamp it extends", () => {
    const names = [
      "202609240000011_notifications_target_post.sql",
      "20260924000001_starpace_core_schema.sql",
      "20260924000002_starpace_grants_and_rls.sql",
    ];
    // The bug: string sort puts the 15-digit name first.
    expect(names.slice().sort()[0]).toBe("202609240000011_notifications_target_post.sql");
    // Without pins it lands between its own base and the next migration.
    expect(sortMigrationFiles(names, [])).toEqual([
      "20260924000001_starpace_core_schema.sql",
      "202609240000011_notifications_target_post.sql",
      "20260924000002_starpace_grants_and_rls.sql",
    ]);
  });

  it("compares digit strings exactly, past Number.MAX_SAFE_INTEGER", () => {
    expect(compareNumericStrings("999999999999999999", "1000000000000000000")).toBe(-1);
    expect(compareVersions("20260924000001", "202609240000010")).toBe(-1);
    expect(compareVersions("20260924000002", "202609240000011")).toBe(1);
    expect(compareVersions("202609240000011", "202609240000011")).toBe(0);
    expect(compareVersions("", "20260924000001")).toBe(1);
    expect(migrationVersion("202609240000011_a.sql")).toBe("202609240000011");
    expect(migrationVersion("db/migrations\\20260924000001_a.sql")).toBe("20260924000001");
    expect(migrationVersion("readme.sql")).toBe("");
  });

  it("keeps unversioned names last, ordered by filename", () => {
    expect(sortMigrationFiles(["zzz.sql", "aaa.sql", "20260924000001_a.sql"], [])).toEqual([
      "20260924000001_a.sql",
      "aaa.sql",
      "zzz.sql",
    ]);
  });

  it("places every file the ledger says ran out of prefix order", () => {
    const ordered = sortMigrationFiles(repoMigrations());
    const at = (part: string) => positionOf(ordered, part);

    // notifications_target_post rewrites the trigger functions that
    // counters_notifications_triggers creates, so it has to follow it.
    expect(at("starpace_core_schema")).toBe(0);
    expect(at("counters_notifications_triggers")).toBeLessThan(at("notifications_target_post"));
    expect(at("starpace_grants_and_rls")).toBeLessThan(at("notifications_target_post"));
    expect(at("notifications_target_post")).toBeLessThan(at("usd_tip_notifications"));

    expect(at("media_bucket_policies")).toBeLessThan(at("messaging_calls_hardening"));
    expect(at("lock_plan_escalation")).toBeLessThan(at("workspace_fixes_and_posts"));
    expect(at("workspace_fixes_and_posts")).toBeLessThan(at("replace_hardcoded_admin"));
    expect(at("starpace_core_schema")).toBeLessThan(at("bound_message_length"));
  });

  it("orders the real migration folder so no ALTER precedes its CREATE", () => {
    const created = new Set<string>();
    const orphans: string[] = [];

    for (const name of sortMigrationFiles(repoMigrations())) {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8").toLowerCase();
      // A file may alter tables it creates itself, so collect its creations
      // before looking for the tables it alters.
      for (const [, table] of sql.matchAll(/create table (?:if not exists )?public\.(\w+)/g)) {
        created.add(table);
      }
      for (const [, table] of sql.matchAll(/alter table (?:if exists )?public\.(\w+)/g)) {
        if (!created.has(table) && !RUNNER_OWNED_TABLES.has(table)) {
          orphans.push(`${name} alters public.${table}`);
        }
      }
    }

    expect(orphans).toEqual([]);
  });

  it("has no two migrations claiming the same version prefix", () => {
    expect(duplicateVersions(repoMigrations())).toEqual([]);
  });

  it("notices when a pin can no longer be honoured", () => {
    expect(unresolvedPins(repoMigrations())).toEqual([]);
    expect(
      unresolvedPins(["20260924000001_starpace_core_schema.sql", "20260924000002_x.sql"]),
    ).toEqual(SHIPPED_POSITION_PINS);
    expect(
      unresolvedPins(
        ["20260924000001_starpace_core_schema.sql"],
        [{ file: "20260924000001_starpace_core_schema.sql", after: "gone.sql" }],
      ),
    ).toEqual([{ file: "20260924000001_starpace_core_schema.sql", after: "gone.sql" }]);
  });

  it("never reorders the pins against a folder they cannot see", () => {
    const ordered = sortMigrationFiles(["20260924000001_a.sql", "20260924000002_b.sql"]);
    expect(ordered).toEqual(["20260924000001_a.sql", "20260924000002_b.sql"]);
  });
});
