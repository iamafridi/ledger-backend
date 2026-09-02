import { describe, expect, it } from "vitest";
import { runDps, MAX_SCHEDULE_MONTHS } from "../src/core/dps.js";

describe("DPS (Deposit Pension Scheme) Core Engine", () => {
  it("calculates DPS compounding correctly with monthly half-up rounding", () => {
    // 1000 deposit per month at 12% annual interest (1% per month)
    // Month 1:
    //   Deposit = 1000, Balance before interest = 1000
    //   Interest = 1000 * 0.12 / 12 = 10.00
    //   Balance after = 1010.00
    // Month 2:
    //   Deposit = 1000, Balance before = 2010.00
    //   Interest = 2010 * 0.12 / 12 = 20.10
    //   Balance after = 2030.10
    const result = runDps({
      monthlyDeposit: "1000.00",
      annualRatePercent: "12.00",
      months: 2,
    });

    expect(result.schedule).toHaveLength(2);
    expect(result.schedule[0].deposit_bdt).toBe("1000.00");
    expect(result.schedule[0].interest_bdt).toBe("10.00");
    expect(result.schedule[0].closing_balance_bdt).toBe("1010.00");

    expect(result.schedule[1].deposit_bdt).toBe("1000.00");
    expect(result.schedule[1].interest_bdt).toBe("20.10");
    expect(result.schedule[1].closing_balance_bdt).toBe("2030.10");

    expect(result.total_deposited_bdt).toBe("2000.00");
    expect(result.total_interest_bdt).toBe("30.10");
    expect(result.maturity_value_bdt).toBe("2030.10");
  });

  it("handles zero months schedule cleanly", () => {
    const result = runDps({
      monthlyDeposit: "5000.00",
      annualRatePercent: "8.00",
      months: 0,
    });

    expect(result.schedule).toHaveLength(0);
    expect(result.total_deposited_bdt).toBe("0.00");
    expect(result.total_interest_bdt).toBe("0.00");
    expect(result.maturity_value_bdt).toBe("0.00");
  });

  it("throws on negative months or non-integer months", () => {
    expect(() =>
      runDps({ monthlyDeposit: "1000.00", annualRatePercent: "8.00", months: -1 }),
    ).toThrow();
    expect(() =>
      runDps({ monthlyDeposit: "1000.00", annualRatePercent: "8.00", months: 2.5 }),
    ).toThrow();
  });

  it("throws when schedule exceeds MAX_SCHEDULE_MONTHS", () => {
    expect(() =>
      runDps({
        monthlyDeposit: "1000.00",
        annualRatePercent: "8.00",
        months: MAX_SCHEDULE_MONTHS + 1,
      }),
    ).toThrow();
  });
});
