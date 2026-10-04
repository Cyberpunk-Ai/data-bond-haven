import { describe, it, expect } from "vitest";
import { errorMessage, friendlyError } from "@/lib/error-messages";

/**
 * `errorMessage` was introduced so the ~45 `catch (err: unknown)` sites could
 * read a caught value's message without reintroducing an `any`. It must be a
 * faithful, side-effect-free stand-in for the old `err?.message`: same output
 * for the shapes a thrown value actually takes, and an empty string for the
 * rest (a bare throw, a null, a number) so callers keep their `|| fallback`
 * behaviour. These cases are exactly what the sweep's three `.message` readers
 * (AiDraftModal, api-client, monetization-state) relied on staying identical.
 */
describe("errorMessage", () => {
  it("returns an Error's own message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("passes a thrown string straight through", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  it("reads a `message` field off a non-Error object (Supabase-shaped rejects)", () => {
    expect(errorMessage({ message: "column does not exist" })).toBe("column does not exist");
  });

  it("coerces a present but non-string message to a string", () => {
    expect(errorMessage({ message: 42 })).toBe("42");
  });

  it("returns an empty string for an object whose message is null/undefined", () => {
    // The old `err?.message ?? ""` contract: a present-but-empty message is "".
    expect(errorMessage({ message: null })).toBe("");
    expect(errorMessage({ message: undefined })).toBe("");
  });

  it("returns an empty string for values with no message at all", () => {
    expect(errorMessage(null)).toBe("");
    expect(errorMessage(undefined)).toBe("");
    expect(errorMessage(404)).toBe("");
    expect(errorMessage({})).toBe("");
    expect(errorMessage({ error: "no message key" })).toBe("");
  });

  it("composes with a fallback the way the catch sites do (empty → fallback)", () => {
    const fallback = "generic failure";
    expect(errorMessage({}) || fallback).toBe(fallback);
    expect(errorMessage(new Error("real")) || fallback).toBe("real");
  });
});

/**
 * A short contract for the sibling helper the sweep also touched, to prove the
 * two do not disagree: an intentional human message survives both, and a raw
 * technical one is honest via errorMessage but never shown by friendlyError.
 */
describe("errorMessage vs friendlyError", () => {
  it("both surface a plain human message unchanged", () => {
    expect(errorMessage("Add your payout account first.")).toBe("Add your payout account first.");
    expect(friendlyError("Add your payout account first.")).toBe("Add your payout account first.");
  });

  it("errorMessage stays raw while friendlyError hides internals", () => {
    const technical = 'duplicate key value violates unique constraint "pkey"';
    expect(errorMessage(new Error(technical))).toBe(technical);
    expect(friendlyError(new Error(technical))).not.toBe(technical);
  });
});
