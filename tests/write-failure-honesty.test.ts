// @vitest-environment node
/**
 * A write that does not happen is a lie in three places: the caller is told it
 * saved, a queue is told the event was consumed, and a rollback is assumed to
 * have rolled back. supabase-js makes this easy to get wrong because a rejected
 * write (RLS, an expired session falling back to `anon`, a network failure)
 * resolves as a normal `{ data: null, error }` — it never throws.
 *
 * These tests read the source of the four paths the audit flagged. Behaviour
 * this narrow needs a live database and a live provider to observe, so the
 * contract is pinned where it can be argued.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** Text between two markers, so an assertion can be about one function only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("the payout webhook cannot retire an event it failed to apply", () => {
  const handler = between(
    read("../src/routes/api/public/paystack/webhook.ts"),
    'if (event.startsWith("transfer."))',
    "---- charges: settle",
  );

  it("reads the error off the status write", () => {
    expect(handler).toContain("error: statusError");
    expect(handler).toMatch(/\.update\(\{\s*\n\s*status,/);
  });

  it("answers non-2xx when the write is refused, so Paystack retries", () => {
    expect(handler).toContain("if (statusError) {");
    const refusal = between(handler, "if (statusError) {", "}");
    expect(refusal).toContain("status: 500");
    // Order matters: the refusal must come before the notification insert, or a
    // creator is told "paid out" about a row that still says `pending`.
    expect(handler.indexOf("if (statusError) {")).toBeLessThan(
      handler.indexOf('from("notifications")'),
    );
  });

  it("names a resolved-but-empty write instead of calling it a no-op", () => {
    // `updated === null` also means "we matched no row", which is not a success.
    expect(handler).toMatch(/else if \(status === "paid" \|\| status === "failed"\) \{/);
    expect(handler).toContain("no payout row for transfer");
  });

  it("keeps the charge path answering 500 on a settle failure", () => {
    const source = read("../src/routes/api/public/paystack/webhook.ts");
    expect(source).toContain('return new Response("settle_error", { status: 500 });');
  });
});

describe("settings write-through reports what it could not save", () => {
  const push = between(
    read("../src/lib/remote-store.ts"),
    "function push(state: T) {",
    "if (typeof window",
  );

  it("inspects the upsert result instead of dropping it", () => {
    expect(push).not.toMatch(/void db\.from\(opts\.table\)\.upsert\([^)]*\)\s*;/);
    expect(push).toContain("res.error");
    expect(push).toContain("write-through failed");
  });

  it("names the table, because the store is generic", () => {
    expect(push).toContain("${opts.table}");
  });
});

describe("call transitions distinguish a lost race from a refused write", () => {
  const source = read("../src/lib/calls.ts");

  it.each(["answerCall", "declineCall", "markCallMissed"] as const)(
    "%s logs the error it cannot tell the UI about",
    (fn) => {
      const body = between(source, `export async function ${fn}`, "export ");
      expect(body).toContain("const { data, error }");
      expect(body).toContain(`${fn} write failed`);
      // The boolean contract is unchanged: a refused write still must not be
      // reported as a won race.
      expect(body).toContain("return (data?.length ?? 0) > 0;");
    },
  );
});

describe("a failed cancel still tries to undo the billing record", () => {
  const cancel = between(
    read("../src/lib/plans.ts"),
    "const { error: planError }",
    'return { plan: "free"',
  );

  it("checks the compensating write", () => {
    expect(cancel).toContain("error: undoError");
    expect(cancel).toContain("rollback failed");
  });

  it("still reports the original failure to the caller", () => {
    expect(cancel).toContain("throw new Error(planError.message");
  });
});

describe("checkout modals do not keep a success screen they can never reach", () => {
  // Both branches rendered off an `isSuccess` flag that nothing ever set: a
  // checkout hands off to a hosted provider page and unloads this app, so a
  // client-side "Tip Sent Successfully!" / "Subscription Active & Verified"
  // could only ever have been a lie — and dead copy is exactly what makes a
  // future reader assume the flow confirms something it cannot know.
  const modal = read("../src/components/social/TipModal.tsx");
  const upgrade = read("../src/components/social/UpgradeModal.tsx");

  it("neither has an unreachable success state", () => {
    expect(modal).not.toContain("isSuccess");
    expect(upgrade).not.toContain("isSuccess");
    expect(modal).not.toMatch(/\bCheck[ ,}]/);
  });

  it("neither claims a payment went through before the provider says so", () => {
    expect(modal).not.toMatch(/sent (that )?tip/i);
    expect(modal).not.toContain("Tip Sent Successfully");
    expect(upgrade).not.toContain("Subscription Active & Verified");
    expect(upgrade).not.toContain("Your account has been upgraded");
  });

  it("both open the hosted checkout and fail loudly if it will not open", () => {
    for (const source of [modal, upgrade]) {
      expect(source).toContain("openPaystackPayment");
      expect(source).toContain("We couldn't open a secure checkout. Please try again.");
    }
  });

  it("keeps the one screen that really can confirm: the billing callback", () => {
    // Server-verified, by reference, after the provider redirects back. This is
    // where the "it worked" message belongs.
    const callback = read("../src/routes/billing.callback.tsx");
    expect(callback).toContain("confirmPaystackPayment");
    expect(callback).toContain('res.status === "success"');
    expect(callback).toContain("Payment confirmed. Your new plan is active.");
  });
});
