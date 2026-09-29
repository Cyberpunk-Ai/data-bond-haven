import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard against double-encoded source text (an em dash stored as three characters
 * instead of one). It happened for real here: a Windows PowerShell 5.1 script
 * read UTF-8 files as Windows-1252 and wrote them back, quietly corrupting every
 * em dash and emoji in 20 files. Tooling on that shell is still the normal
 * workflow, so the check lives with the tests instead of in someone's memory.
 */
const ROOTS = ["src", "db", "tests"];
const EDITABLE = /\.(ts|tsx|css|md|sql|json|html|toml|js|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".output", ".nitro"]);

// C1 controls never belong in source text. A lead character (U+00C2, U+00C3 or
// U+00E2) glued to a Latin-1/Windows-1252 punctuation mark is the signature of
// UTF-8 bytes that were decoded as CP1252 and then saved as UTF-8 again.
const SUSPICIOUS =
  /[\u0080-\u009f\u2028\u2029]|[\u00c2\u00c3\u00e2][\u0080-\u00bf\u00a0-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (EDITABLE.test(entry)) out.push(full);
  }
  return out;
}

describe("source file encoding", () => {
  it("contains no double-encoded (mojibake) sequences", () => {
    const broken: string[] = [];
    for (const dir of ROOTS) {
      for (const file of sourceFiles(dir)) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        const line = lines.findIndex((l) => SUSPICIOUS.test(l));
        if (line >= 0) broken.push(`${file}:${line + 1}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
