import { describe, expect, it } from "vitest";
import { estimateTokens, sizeTierFor } from "./vocabulary.ts";

describe("sizeTierFor", () => {
  it("maps source tokens to tiers at the boundaries", () => {
    expect(sizeTierFor(0)).toBe("S");
    expect(sizeTierFor(149_999)).toBe("S");
    expect(sizeTierFor(150_000)).toBe("M");
    expect(sizeTierFor(999_999)).toBe("M");
    expect(sizeTierFor(1_000_000)).toBe("L");
    expect(sizeTierFor(4_999_999)).toBe("L");
    expect(sizeTierFor(5_000_000)).toBe("XL");
  });
});

describe("estimateTokens", () => {
  it("rounds up and handles empty files", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(3700)).toBe(1000);
  });
});
