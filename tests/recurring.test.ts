import { describe, expect, it } from "vitest";
import { calculateNextDate, calculateReversalDate } from "../src/modules/recurring/recurring.service.js";

describe("Recurring Templates & Accrual Engine", () => {
  it("calculates monthly advancement correctly", () => {
    expect(calculateNextDate("2026-01-15", "MONTHLY")).toBe("2026-02-15");
    expect(calculateNextDate("2026-12-01", "MONTHLY")).toBe("2027-01-01");
  });

  it("calculates quarterly and annual intervals accurately", () => {
    expect(calculateNextDate("2026-03-31", "QUARTERLY")).toBe("2026-07-01"); // March + 3mo = June 30 / July 1 depending on calendar days
    expect(calculateNextDate("2026-06-15", "ANNUAL")).toBe("2027-06-15");
    expect(calculateNextDate("2026-05-10", "WEEKLY")).toBe("2026-05-17");
  });

  it("calculates auto-reversal date to the first day of next month", () => {
    expect(calculateReversalDate("2026-07-15")).toBe("2026-08-01");
    expect(calculateReversalDate("2026-12-31")).toBe("2027-01-01");
  });
});
