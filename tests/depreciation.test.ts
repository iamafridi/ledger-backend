import { describe, expect, it } from "vitest";
import {
  chargeDays,
  chargeForPeriod,
  depreciableBase,
  monthlyCharge,
} from "../src/core/depreciation.js";
import { fmt, money, ZERO } from "../src/core/money.js";

describe("Fixed Asset Straight-Line Depreciation", () => {
  const terms = {
    cost: money("120000.00"),
    salvage: money("12000.00"),
    usefulLifeMonths: 36,
  };

  it("calculates depreciable base as cost minus salvage", () => {
    const base = depreciableBase(terms);
    expect(fmt(base)).toBe("108000.00");
  });

  it("calculates exact monthly charge", () => {
    // 108,000 / 36 = 3000.00
    const charge = monthlyCharge(terms);
    expect(fmt(charge)).toBe("3000.00");
  });

  it("calculates service days correctly for full and partial months", () => {
    // Purchased on 1st of January (31 days)
    expect(chargeDays("2026-01", "2026-01-01")).toBe(31);
    // Purchased on 16th of January (31 - 16 + 1 = 16 days)
    expect(chargeDays("2026-01", "2026-01-16")).toBe(16);
    // Prior purchase in an earlier month
    expect(chargeDays("2026-02", "2026-01-16")).toBe(28);
  });

  it("computes standard monthly depreciation charge", () => {
    const charge = chargeForPeriod(terms, ZERO, "2026-02", "2026-01-01");
    expect(fmt(charge.amount)).toBe("3000.00");
    expect(charge.prorated).toBe(false);
    expect(charge.final).toBe(false);
  });

  it("prorates first month charge when purchased mid-month", () => {
    // In April (30 days), bought on 2026-04-16 -> 15 days out of 30 -> exactly half
    const charge = chargeForPeriod(terms, ZERO, "2026-04", "2026-04-16");
    expect(fmt(charge.amount)).toBe("1500.00");
    expect(charge.prorated).toBe(true);
    expect(charge.final).toBe(false);
  });

  it("caps final period charge at exact remaining depreciable base", () => {
    // Remaining base is only 500.00, but monthly charge is 3000.00
    const accum = money("107500.00");
    const charge = chargeForPeriod(terms, accum, "2026-05", "2026-01-01");
    expect(fmt(charge.amount)).toBe("500.00");
    expect(charge.final).toBe(true);
  });

  it("returns zero when asset is fully written down", () => {
    const accum = money("108000.00");
    const charge = chargeForPeriod(terms, accum, "2026-06", "2026-01-01");
    expect(fmt(charge.amount)).toBe("0.00");
    expect(charge.final).toBe(false);
  });
});
