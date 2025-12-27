import { describe, expect, it } from "vitest";

import { Xorshift32 } from "./xorshift32.js";

describe("Xorshift32", () => {
  it("produces the locked sequence for seed=1", () => {
    const rng = new Xorshift32(1);
    expect(rng.nextUint32()).toBe(270369);
    expect(rng.nextUint32()).toBe(67634689);
    expect(rng.nextUint32()).toBe(2647435461);
    expect(rng.nextUint32()).toBe(307599695);
    expect(rng.nextUint32()).toBe(2398689233);
  });

  it("is deterministic for the same seed", () => {
    const a = new Xorshift32(123456789);
    const b = new Xorshift32(123456789);

    for (let i = 0; i < 50; i += 1) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it("stores and updates uint32 state", () => {
    const rng = new Xorshift32(-1);
    expect(rng.state).toBe(0xffffffff);
    rng.nextUint32();
    expect(Number.isInteger(rng.state)).toBe(true);
    expect(rng.state).toBeGreaterThanOrEqual(0);
    expect(rng.state).toBeLessThanOrEqual(0xffffffff);
  });
});
