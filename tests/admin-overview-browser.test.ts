// @vitest-environment node
/**
 * The admin overview builds its payload at the very end with Node-only health
 * numbers. In a browser `process` is an *undeclared identifier*, so even
 * `process.memoryUsage?.()` throws ReferenceError — which rejected a request
 * whose every query had already succeeded, and the console showed the visitor
 * "check your connection".
 *
 * The guard is a `typeof` probe plus a pure helper, so the helper is what gets
 * tested. An earlier version of this file deleted the worker's `process` global
 * to imitate a browser; if the run was aborted mid-await the mutation leaked
 * into whatever test ran next on that worker, and vitest's own machinery was
 * running blind while the call was in flight. Nothing here touches a global.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const RESULT = { data: [] as unknown[], count: 42, error: null };

const QUERY_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gte",
  "lte",
  "or",
  "order",
  "limit",
  "range",
  "in",
  "not",
  "is",
  "like",
  "maybeSingle",
  "single",
  "textSearch",
  "filter",
];

/** A PostgREST builder that answers every chain with the same canned result. */
function fakeQuery() {
  const builder: Record<string, unknown> = {};
  for (const method of QUERY_METHODS) builder[method] = () => builder;
  builder.then = (
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ) => Promise.resolve(RESULT).then(onfulfilled, onrejected);
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => fakeQuery(),
    rpc: () =>
      Promise.resolve({
        data: [{ count: "2", amount: "26.00", currency: "KES" }],
        error: null,
      }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    },
    storage: { from: () => ({ list: () => Promise.resolve({ data: [], error: null }) }) },
  },
}));

const { getAdminOverview, heapMbFrom } = await import("@/lib/api-client");

const MIB = 1024 * 1024;

describe("heapMbFrom", () => {
  it("reports zero when there is no Node environment to ask", () => {
    // A browser imports this module with no `process` at all: the probe hands
    // the helper `undefined`, and the payload must still be built.
    expect(heapMbFrom(undefined)).toBe(0);
    expect(heapMbFrom(null)).toBe(0);
    expect(heapMbFrom({})).toBe(0);
  });

  it("reports zero when the probe answers something that is not a number", () => {
    expect(heapMbFrom({ memoryUsage: () => ({}) } as never)).toBe(0);
    expect(heapMbFrom({ memoryUsage: () => ({ heapUsed: NaN }) })).toBe(0);
    expect(heapMbFrom({ memoryUsage: () => ({ heapUsed: -1 }) })).toBe(0);
  });

  it("rounds megabytes the way the dashboard prints them", () => {
    expect(heapMbFrom({ memoryUsage: () => ({ heapUsed: 42 * MIB }) })).toBe(42);
    expect(heapMbFrom({ memoryUsage: () => ({ heapUsed: Math.round(1.4 * MIB) }) })).toBe(1);
  });

  it("measures the real heap when it runs on the server", () => {
    const real = heapMbFrom(process);
    expect(Number.isFinite(real)).toBe(true);
    expect(real).toBeGreaterThan(0);
  });
});

describe("the browser-safe probe", () => {
  // `typeof process` is the only legal way to name an undeclared identifier;
  // `process.memoryUsage?.()` still throws in a browser and that throw was the
  // bug. This keeps the fix from being "simplified" back into a regression.
  const source = readFileSync(new URL("../src/lib/api-client.ts", import.meta.url), "utf8").replace(
    /\s+/g,
    " ",
  );

  // Only the function body counts: its doc comment is allowed to spell out the
  // dangerous expression to explain why the probe is written this way.
  const body = source.slice(
    source.indexOf("function nodeMemoryMb"),
    source.indexOf("// ---", source.indexOf("function nodeMemoryMb")),
  );

  it("tests process with typeof instead of touching it", () => {
    expect(body).toMatch(/heapMbFrom\(typeof process === "undefined" \? undefined : process\)/);
  });

  it("never dereferences process in the body", () => {
    expect(body).not.toMatch(/process\.memoryUsage/);
  });

  it("keeps the guard honest: an env with no probe still yields a number", () => {
    // Negative control for the two assertions above — if `heapMbFrom` ever
    // grew a hard dependency on Node, the payload builder would throw again.
    expect(heapMbFrom(globalThis as never)).not.toBeNaN();
  });
});

describe("admin overview payload", () => {
  it("resolves with every health field filled, on the server", async () => {
    const data = await getAdminOverview({ force: true });
    expect(data.stats.total_users).toBe(42);
    expect(data.stats.total_tips_amount).toBe(26);
    expect(data.stats.system_health.memory_mb).toBeGreaterThan(0);
    expect(data.charts.daily_impressions).toHaveLength(7);
  }, 30_000); // second or two on a busy machine; the default 5 s budget is not the point. // The first call transforms the whole api-client module, which can take a
});
