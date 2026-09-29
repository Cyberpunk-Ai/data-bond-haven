// @vitest-environment node
/**
 * The admin overview builds its payload at the very end with Node-only health
 * numbers. In a browser `process` is an *undeclared identifier*, so even
 * `process.memoryUsage?.()` throws ReferenceError — which rejected a request
 * whose every query had already succeeded, and the console showed the visitor
 * "check your connection". These tests run the real builder with and without a
 * Node global so the class of bug stays fixed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const RESULT = { data: [] as unknown[], count: 42, error: null };

function fakeQuery(result: typeof RESULT) {
  const builder: Record<string, unknown> = {};
  for (const method of [
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
  ]) {
    builder[method] = () => builder;
  }
  builder.then = (
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ) => Promise.resolve(result).then(onfulfilled, onrejected);
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => fakeQuery(RESULT),
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

const realProcess = globalThis.process;

async function overviewWithoutNodeGlobals() {
  const { getAdminOverview } = await import("@/lib/api-client");
  // Take Node's global away so the builder runs as it would in a browser. A
  // browser reads `process` as an undeclared identifier (ReferenceError); here
  // it resolves to undefined (TypeError) — different words, same throw at the
  // same expression, which is what this test is about.
  Object.defineProperty(globalThis, "process", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return await getAdminOverview({ force: true });
  } finally {
    Object.defineProperty(globalThis, "process", {
      value: realProcess,
      configurable: true,
      writable: true,
    });
  }
}

describe("admin overview payload", () => {
  afterEach(() => vi.resetModules());

  it("resolves in a browser-like environment with no process global", async () => {
    const data = await overviewWithoutNodeGlobals();
    expect(data.stats.total_users).toBe(42);
    expect(data.stats.total_tips_amount).toBe(26);
    // Nothing to measure without Node: report zero rather than throw.
    expect(data.stats.system_health.memory_mb).toBe(0);
    expect(data.charts.daily_impressions).toHaveLength(7);
  });

  it("still reports real heap usage when it runs on the server", async () => {
    const { getAdminOverview } = await import("@/lib/api-client");
    const data = await getAdminOverview({ force: true });
    expect(data.stats.system_health.memory_mb).toBeGreaterThan(0);
  });
});
