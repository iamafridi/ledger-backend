import { describe, expect, it } from "vitest";
import { accumulateBands, lineTax, truncateToTaka, type BandAccumulator } from "../src/core/tax.js";
import { fmt, money, ZERO } from "../src/core/money.js";

describe("Tax & VAT Engine Calculations", () => {
  it("computes exclusive tax with discount applied before tax", () => {
    // 10 units @ 100.00 each = 1000.00 gross
    // Discount = 100.00 -> taxable net = 900.00
    // VAT 15% on 900.00 = 135.00
    // Total = 1035.00
    const res = lineTax({
      unitPrice: money("100.00"),
      qty: 10,
      discount: money("100.00"),
      ratePercent: money("15.00"),
      mode: "EXCLUSIVE",
    });

    expect(fmt(res.gross)).toBe("1000.00");
    expect(fmt(res.net)).toBe("900.00");
    expect(fmt(res.tax)).toBe("135.00");
    expect(fmt(res.total)).toBe("1035.00");
  });

  it("extracts inclusive tax correctly without rounding discrepancy", () => {
    // 1 unit @ 115.00 inclusive of 15% VAT
    // Taxable = 115.00
    // Net = 115 * 100 / 115 = 100.00
    // Tax = 115 - 100 = 15.00
    // Total = 115.00
    const res = lineTax({
      unitPrice: money("115.00"),
      qty: 1,
      discount: ZERO,
      ratePercent: money("15.00"),
      mode: "INCLUSIVE",
    });

    expect(fmt(res.net)).toBe("100.00");
    expect(fmt(res.tax)).toBe("15.00");
    expect(fmt(res.total)).toBe("115.00");
  });

  it("handles zero tax rate lines cleanly", () => {
    const res = lineTax({
      unitPrice: money("50.00"),
      qty: 4,
      discount: ZERO,
      ratePercent: ZERO,
      mode: "EXCLUSIVE",
    });

    expect(fmt(res.gross)).toBe("200.00");
    expect(fmt(res.net)).toBe("200.00");
    expect(fmt(res.tax)).toBe("0.00");
    expect(fmt(res.total)).toBe("200.00");
  });

  it("truncates VAT return amounts to whole taka towards zero", () => {
    expect(fmt(truncateToTaka(money("1234.85")))).toBe("1234.00");
    expect(fmt(truncateToTaka(money("500.10")))).toBe("500.00");
    expect(fmt(truncateToTaka(money("99.99")))).toBe("99.00");
  });

  it("accumulates taxable bands accurately", () => {
    const map = new Map<string, BandAccumulator>();
    accumulateBands(map, [
      { tax_code: "VAT15", tax_rate_snapshot: "15.00", net_bdt: "1000.00", tax_bdt: "150.00" },
      { tax_code: "VAT15", tax_rate_snapshot: "15.00", net_bdt: "2000.00", tax_bdt: "300.00" },
      { tax_code: "VAT05", tax_rate_snapshot: "5.00", net_bdt: "500.00", tax_bdt: "25.00" },
    ]);

    const vat15 = map.get("VAT15");
    expect(vat15).toBeDefined();
    expect(fmt(vat15!.net)).toBe("3000.00");
    expect(fmt(vat15!.tax)).toBe("450.00");

    const vat05 = map.get("VAT05");
    expect(vat05).toBeDefined();
    expect(fmt(vat05!.net)).toBe("500.00");
    expect(fmt(vat05!.tax)).toBe("25.00");
  });
});
