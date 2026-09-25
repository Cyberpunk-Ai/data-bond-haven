import { describe, expect, it } from "vitest";

import { signatureMatches, sniffMediaType } from "@/lib/media-signature";

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

function asciiPrefix(s: string, total = 16): Uint8Array {
  const arr = new Uint8Array(total);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

describe("sniffMediaType", () => {
  it("recognises core image signatures", () => {
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0x00))).toBe("image/jpeg");
    expect(sniffMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMediaType(asciiPrefix("GIF89a"))).toBe("image/gif");
    expect(sniffMediaType(asciiPrefix("RIFFxxxxWEBP"))).toBe("image/webp");
  });

  it("recognises audio and video containers", () => {
    expect(sniffMediaType(asciiPrefix("RIFFxxxxWAVE"))).toBe("audio/wav");
    expect(sniffMediaType(asciiPrefix("ID3\u0004\u0000"))).toBe("audio/mpeg");
    expect(sniffMediaType(bytes(0xff, 0xfb, 0x90, 0x00))).toBe("audio/mpeg");
    // ftyp brands
    expect(sniffMediaType(asciiPrefix("\u0000\u0000\u0000 ftypisom"))).toBe("video/mp4");
    expect(sniffMediaType(asciiPrefix("\u0000\u0000\u0000 ftypqt  "))).toBe("video/quicktime");
  });

  it("returns null for unrecognised payloads", () => {
    expect(sniffMediaType(asciiPrefix("<html><script>"))).toBeNull();
    expect(sniffMediaType(new Uint8Array(0))).toBeNull();
  });
});

describe("signatureMatches", () => {
  it("accepts a declared type corroborated by the real bytes", () => {
    expect(signatureMatches("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xdb))).toBe(true);
    expect(
      signatureMatches("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe(true);
    expect(signatureMatches("video/webm", asciiPrefix("\u001aE\xdf\xa3webm"))).toBe(true);
  });

  it("accepts a browser audio/webm recording whose DocType is 'webm' not 'weba'", () => {
    // MediaRecorder writes audio as an EBML container with DocType "webm", so
    // sniff reports video/webm; the shared Matroska family must still accept it
    // as the declared audio/webm (regression: recording uploads were 415'd).
    const recording = asciiPrefix("\u001aE\xdf\xa3\x84\x81\x01\x9f\x42\x82\x84webm\x81");
    expect(signatureMatches("audio/webm", recording)).toBe(true);
  });

  it("still refuses foreign bytes renamed to an audio/webm type", () => {
    const html = asciiPrefix("<html><script>alert(1)</script>");
    expect(signatureMatches("audio/webm", html)).toBe(false);
  });

  it("rejects a renamed non-media payload claiming to be an image (the polyglot case)", () => {
    const html = asciiPrefix("<!DOCTYPE html><script>alert(1)</script>");
    expect(signatureMatches("image/jpeg", html)).toBe(false);
  });

  it("rejects a type whose declared kind disagrees with the sniffed kind", () => {
    // Real JPEG bytes declared as a video type → refuse.
    expect(signatureMatches("video/mp4", bytes(0xff, 0xd8, 0xff, 0xdb))).toBe(false);
  });

  it("rejects content types that are not on the allowlist at all", () => {
    expect(signatureMatches("image/svg+xml", bytes(0xff, 0xd8, 0xff))).toBe(false);
    expect(signatureMatches("application/pdf", bytes(0x25, 0x50, 0x44, 0x46))).toBe(false);
  });
});
