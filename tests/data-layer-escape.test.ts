import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase-3 decision: the service-role client is a deliberate escape hatch, but
 * it is allowed to exist in exactly ONE reviewed place — `adminDb()` in
 * `client.server.ts` — instead of being re-cast `supabaseAdmin as any` at every
 * call site. That keeps the schema escape honest (visible, greppable) and lets
 * `@typescript-eslint/no-explicit-any` run as a non-blocking warning without a
 * flood of errors, so the data layer can be re-typed incrementally without the
 * escape regressing across hundreds of files.
 *
 * These are source-contract guards, not behaviour tests: they fail loudly if the
 * centralisation is undone (a raw cast reappears) or the rule is silently
 * re-escalated back to `error`, which would be an unrelated, churny project.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".output", ".nitro"]);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("data-layer escape is centralised behind adminDb()", () => {
  it("no call site re-casts the service-role client with `supabaseAdmin as any`", () => {
    const offenders = tsFiles("src")
      .filter((f) => !f.endsWith(join("integrations", "supabase", "client.server.ts")))
      .filter((f) => readFileSync(f, "utf8").includes("supabaseAdmin as any"));
    expect(offenders).toEqual([]);
  });

  it("the single escape is exported from client.server with an explicit review note", () => {
    const client = readFileSync(
      join("src", "integrations", "supabase", "client.server.ts"),
      "utf8",
    );
    expect(client).toMatch(/export function adminDb\(/);
    expect(client).toMatch(/export type LooseAdminClient = any;/);
    // The looseness is intentional and must stay annotated as such.
    expect(client).toMatch(/no-explicit-any/);
  });

  it("`no-explicit-any` stays a warning so lint holds at zero errors", () => {
    const eslintConfig = readFileSync("eslint.config.js", "utf8");
    expect(eslintConfig).toMatch(/"@typescript-eslint\/no-explicit-any":\s*"warn"/);
  });
});
