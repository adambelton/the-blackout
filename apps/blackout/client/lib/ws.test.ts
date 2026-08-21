import { describe, expect, it } from "vitest";
import { reconnectDelay, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from "./ws";

// Tests for the reconnect backoff contract. The hook lifecycle (mount,
// unmount, enabled flag) is exercised end-to-end by the matchroom and
// moderator pages; here we pin the formula so a change to the delay
// calculation is a deliberate, visible decision.

describe("reconnectDelay", () => {
  it("returns the base delay on the first attempt", () => {
    expect(reconnectDelay(0)).toBe(RECONNECT_BASE_MS);
  });

  it("doubles the delay on each subsequent attempt", () => {
    expect(reconnectDelay(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectDelay(2)).toBe(RECONNECT_BASE_MS * 4);
  });

  it("caps at RECONNECT_CAP_MS regardless of attempt count", () => {
    // attempt 3 would be 12 000ms without the cap
    expect(reconnectDelay(3)).toBe(RECONNECT_CAP_MS);
    expect(reconnectDelay(10)).toBe(RECONNECT_CAP_MS);
    expect(reconnectDelay(100)).toBe(RECONNECT_CAP_MS);
  });

  it("the sequence before the cap matches the documented 1.5s → 3s → 6s → 10s progression", () => {
    expect(reconnectDelay(0)).toBe(1_500);
    expect(reconnectDelay(1)).toBe(3_000);
    expect(reconnectDelay(2)).toBe(6_000);
    expect(reconnectDelay(3)).toBe(10_000);
  });
});
