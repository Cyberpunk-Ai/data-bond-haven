// @vitest-environment node
/**
 * Who is allowed to learn that somebody runs the platform.
 *
 * `has_role(_user_id, _role)` has been callable by `anon` since the first
 * schema: anyone holding any auth uuid — scraped off a profile, a mention or a
 * guess — could ask "is this an administrator?" and get a yes/no. That is a
 * target list for the people who moderate the platform, while the table behind
 * it (`user_roles`) is deliberately protected by `roles self read`. The gate is
 * only safe because every real caller asks about *itself*, which is what the
 * second block below proves.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  new URL("../db/migrations/20261001000097_gate_role_lookup.sql", import.meta.url),
  "utf8",
);

const isStaff = MIGRATION.slice(
  MIGRATION.indexOf("create or replace function public.is_staff()"),
  MIGRATION.indexOf("-- 2. Answer only"),
);
const hasRole = MIGRATION.slice(
  MIGRATION.indexOf("create or replace function public.has_role"),
  MIGRATION.indexOf("-- 3. Anonymous callers"),
);

describe("the gated role lookup", () => {
  it("computes staff-ness without calling has_role (the two would recurse)", () => {
    expect(isStaff).toContain("from public.user_roles r");
    expect(isStaff).not.toContain("has_role");
    expect(hasRole).toContain("public.is_staff()");
  });

  it("keeps the three answers that are legitimate", () => {
    expect(hasRole).toContain("auth.role() = 'service_role'");
    expect(hasRole).toContain("_user_id = auth.uid()");
    expect(hasRole).toContain("or public.is_staff()");
    // …and the answer is still the real one, not a blanket true.
    expect(hasRole).toMatch(/and exists \(\s*select 1\s*from public\.user_roles r/);
  });

  it("is still definer-owned with a pinned search path", () => {
    expect(hasRole).toContain("security definer");
    expect(hasRole).toContain("set search_path = public, pg_temp");
    expect(isStaff).toContain("security definer");
    expect(isStaff).toContain("set search_path = public, pg_temp");
  });

  it("takes the question away from anonymous callers", () => {
    expect(MIGRATION).toContain(
      "revoke execute on function public.has_role(uuid, public.app_role) from public, anon;",
    );
    expect(MIGRATION).toContain(
      "grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;",
    );
  });
});

describe("nothing in the app asks about a third party", () => {
  // The gate silently returns false for another user's id, so a caller that
  // *needs* a third party's answer would break in the safest possible way: by
  // denying access. This keeps the intent written down where it can be argued.
  const SELF_ID =
    /(_user_id:\s*(?:userId|authUserId|context\.userId|data\.userId|user\.id)\b|auth\.uid\(\))/;

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  const calls = tsFiles("src")
    .map((file) => {
      const source = readFileSync(file, "utf8");
      const found: { file: string; snippet: string }[] = [];
      let at = source.indexOf('rpc("has_role"');
      while (at >= 0) {
        found.push({ file, snippet: source.slice(at, at + 160) });
        at = source.indexOf('rpc("has_role"', at + 1);
      }
      return found;
    })
    .flat();

  it("has call-sites to check at all (this guard is not vacuous)", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls.map((c, i) => [i, c.file, c.snippet] as const))(
    "call #%i asks about the caller (%s)",
    (_i, _file, snippet) => {
      expect(snippet).toMatch(SELF_ID);
    },
  );
});
