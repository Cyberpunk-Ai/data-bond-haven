import { describe, it, expect } from "vitest";
import {
  toMinor,
  minorToMajor,
  normalizeCurrency,
  quoteTip,
  feeFromBps,
  reduceLedger,
} from "@/lib/money";

describe("money minor-unit helpers", () => {
  it("rounds to whole minor units and rejects non-finite / unsafe values", () => {
    expect(toMinor(650)).toBe(650);
    expect(toMinor(649.6)).toBe(650);
    expect(() => toMinor(NaN)).toThrow(/finite/);
    expect(() => toMinor(2 ** 54)).toThrow(/safe integer/);
  });

  it("converts minor → major without binary float drift", () => {
    expect(minorToMajor(65000)).toBe(650);
    expect(minorToMajor(1)).toBe(0.01);
    expect(minorToMajor(117000)).toBe(1170);
  });

  it("validates ISO-4217 codes and falls back", () => {
    expect(normalizeCurrency("kes", "NGN")).toBe("KES");
    expect(normalizeCurrency("  USD  ", "KES")).toBe("USD");
    expect(normalizeCurrency("dollars", "KES")).toBe("KES");
    expect(normalizeCurrency(null, "KES")).toBe("KES");
  });
});

describe("quoteTip (the §4.1 misstatement fix)", () => {
  it("charges whole settlement units and derives every figure from them", () => {
    // $5 at 130 KES/USD -> KES 650 = 65000 minor.
    const q = quoteTip({ usd: 5, rate: 130 });
    expect(q.majorSettlement).toBe(650);
    expect(q.minorSettlement).toBe(65000);
    expect(q.usdMinor).toBe(500);
    expect(minorToMajor(q.minorSettlement)).toBe(q.majorSettlement);
  });

  it("rejects a non-positive amount or rate", () => {
    expect(() => quoteTip({ usd: 0, rate: 130 })).toThrow(/positive/);
    expect(() => quoteTip({ usd: 5, rate: 0 })).toThrow(/positive/);
  });
});

describe("feeFromBps", () => {
  it("computes the platform fee in minor units", () => {
    expect(feeFromBps(65000, 500)).toBe(3250); // 5% of KES 650 = KES 32.50
    expect(feeFromBps(65000, 0)).toBe(0);
    expect(feeFromBps(65000, 10000)).toBe(65000);
  });

  it("rejects out-of-range basis points", () => {
    expect(() => feeFromBps(65000, 500.5)).toThrow(/integer/);
    expect(() => feeFromBps(65000, 20000)).toThrow(/10000/);
  });
});

describe("reduceLedger", () => {
  it("never lets the available balance go negative", () => {
    const led = reduceLedger({ netMinor: [10000, 20000], withdrawnMinor: [100000] });
    expect(led.grossMinor).toBe(30000);
    expect(led.availableMinor).toBe(0);
  });

  it("subtracts settled withdrawals from net earnings", () => {
    const led = reduceLedger({ netMinor: [50000, 50000], withdrawnMinor: [30000] });
    expect(led.grossMinor).toBe(100000);
    expect(led.withdrawnMinor).toBe(30000);
    expect(led.availableMinor).toBe(70000);
  });
});
