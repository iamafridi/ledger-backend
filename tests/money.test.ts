import { describe, expect, it } from "vitest";
import { add, display, div, fmt, money, mul, sub, toPaisa, ZERO } from "../src/core/money.js";

describe("Money arithmetic & exact paisa precision", () => {
  it("never exhibits IEEE-754 binary floating point drift", () => {
    // In JS float: 0.1 + 0.2 = 0.30000000000000004
    const a = money("0.10");
    const b = money("0.20");
    const sum = add(a, b);
    expect(fmt(sum)).toBe("0.30");
  });

  it("performs standard arithmetic correctly", () => {
    const a = money("100.50");
    const b = money("50.25");

    expect(fmt(add(a, b))).toBe("150.75");
    expect(fmt(sub(a, b))).toBe("50.25");
    expect(fmt(mul(a, 2))).toBe("201.00");
    expect(fmt(div(a, 2))).toBe("50.25");
  });

  it("rounds half-up to the nearest paisa", () => {
    expect(fmt(toPaisa(money("10.005")))).toBe("10.01");
    expect(fmt(toPaisa(money("10.004")))).toBe("10.00");
    expect(fmt(toPaisa(money("10.0051")))).toBe("10.01");
  });

  it("formats canonical 2dp strings", () => {
    expect(fmt(ZERO)).toBe("0.00");
    expect(fmt(money("50000"))).toBe("50000.00");
    expect(fmt(money("123.456"))).toBe("123.46");
  });

  it("formats display strings with comma separators", () => {
    expect(display(money("1234567.89"))).toBe("1,234,567.89");
    expect(display(money("-9876.50"))).toBe("-9,876.50");
    expect(display(ZERO)).toBe("0.00");
  });

  it("rejects non-finite money values", () => {
    expect(() => money(NaN)).toThrow();
    expect(() => money(Infinity)).toThrow();
  });
});
