import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_CHARS,
  MAX_SPACE_CHAT_CHARS,
  MESSAGE_COUNTER_WARN_AT,
  isMessageWithinLimit,
  lengthError,
  messageCharsOver,
  messageCounterLabel,
  messageLength,
  messageLengthError,
  remainingMessageChars,
  shouldShowMessageCounter,
} from "@/lib/message-length";

/**
 * A DM body used to be unbounded: no cap in the composer, none in the write path,
 * no check on the column. One signed-in token could store a five-megabyte message
 * that every later inbox read had to carry and every bubble had to render.
 *
 * These are the client's half of that rule; the database half is
 * `messages_body_length` in db/migrations, and the two numbers have to agree.
 */

describe("the cap counts what a person sees", () => {
  it("is big enough for a paragraph and small enough to render", () => {
    expect(MAX_MESSAGE_CHARS).toBeGreaterThanOrEqual(1000);
    expect(MAX_MESSAGE_CHARS).toBeLessThanOrEqual(10_000);
  });

  it("counts code points, which is what the database counts", () => {
    // Postgres `char_length()` counts code points, so the composer must count the
    // same thing or the two halves of this rule disagree — the failure being a
    // message the counter said was fine and the insert then refused.
    expect(messageLength("👍")).toBe(1); // two UTF-16 units, one character
    expect(messageLength("❤️")).toBe(2); // heart + variation selector
    expect(messageLength("a".repeat(MAX_MESSAGE_CHARS))).toBe(MAX_MESSAGE_CHARS);
    expect(messageLength("")).toBe(0);
    expect(messageLength(null as unknown as string)).toBe(0);
  });

  it("allows exactly the cap and refuses one more", () => {
    expect(messageLengthError("x".repeat(MAX_MESSAGE_CHARS))).toBeNull();
    expect(messageLengthError("x".repeat(MAX_MESSAGE_CHARS + 1))).not.toBeNull();
  });
});

describe("the message it gives you", () => {
  it("says how far over, so you know how much to cut", () => {
    const error = messageLengthError("x".repeat(MAX_MESSAGE_CHARS + 250));
    expect(error).toContain(String(MAX_MESSAGE_CHARS));
    expect(error).toContain("250");
  });

  it("is a sentence rather than a constraint name", () => {
    // The database would have answered `new row violates row-level security
    // policy …` / `messages_body_length`, which is what users currently report as
    // "message could not be sent" with no idea why.
    const error = messageLengthError("x".repeat(MAX_MESSAGE_CHARS + 1)) ?? "";
    expect(error.startsWith("A message can be up to")).toBe(true);
    expect(error).not.toContain("messages_body_length");
  });
});

describe("the counter appears when it is useful", () => {
  it("stays out of the way until you are near the limit", () => {
    expect(shouldShowMessageCounter("hi")).toBe(false);
    expect(shouldShowMessageCounter("x".repeat(MAX_MESSAGE_CHARS - MESSAGE_COUNTER_WARN_AT))).toBe(
      true,
    );
  });

  it("never counts below zero, and says how far over instead", () => {
    expect(remainingMessageChars("x".repeat(MAX_MESSAGE_CHARS + 500))).toBe(0);
    expect(remainingMessageChars("hello")).toBe(MAX_MESSAGE_CHARS - 5);
    expect(messageCounterLabel("hello")).toBe(String(MAX_MESSAGE_CHARS - 5));
    // The composer shows a negative number rather than stopping the caret, so a
    // pasted paragraph is never silently truncated.
    expect(messageCounterLabel("x".repeat(MAX_MESSAGE_CHARS + 500))).toBe("-500");
    expect(isMessageWithinLimit("x".repeat(MAX_MESSAGE_CHARS + 500))).toBe(false);
    expect(messageCharsOver("hello")).toBe(0);
  });

  it("still shows the counter once you are past the limit", () => {
    expect(shouldShowMessageCounter("x".repeat(MAX_MESSAGE_CHARS + 10))).toBe(true);
  });
});

describe("space chat is bounded too", () => {
  it("has its own, shorter ceiling than a DM", () => {
    // A room message is one line among many, re-read by everyone in the space.
    expect(MAX_SPACE_CHAT_CHARS).toBeLessThan(MAX_MESSAGE_CHARS);
  });

  it("refuses past its own ceiling and not the DM one", () => {
    const text = "x".repeat(MAX_SPACE_CHAT_CHARS + 1);
    expect(lengthError(text, MAX_SPACE_CHAT_CHARS)).toContain(String(MAX_SPACE_CHAT_CHARS));
    expect(lengthError(text, MAX_MESSAGE_CHARS)).toBeNull();
    expect(lengthError("hello", MAX_SPACE_CHAT_CHARS)).toBeNull();
  });

  it("says the same number the database will enforce", () => {
    // Two halves of one rule, written in two languages. If the constraint moves
    // without the client (or the other way round), a message either fails with a
    // constraint name the user was never warned about, or is stored unbounded.
    const migration = readFileSync(
      new URL("../db/migrations/20261001000095_bound_message_length.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(`char_length(body) <= ${MAX_MESSAGE_CHARS}`);
    expect(migration).toContain(`char_length(body) <= ${MAX_SPACE_CHAT_CHARS}`);
  });
});
