import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../src/rateLimiter.js";

describe("createRateLimiter (token bucket, per-key)", () => {
  it("allows up to burst requests, then rejects with retry-after", () => {
    let t = 0;
    const limiter = createRateLimiter({ ratePerMinute: 60, burst: 3, now: () => t });

    expect(limiter.tryAcquire("a")).toEqual({ allowed: true });
    expect(limiter.tryAcquire("a")).toEqual({ allowed: true });
    expect(limiter.tryAcquire("a")).toEqual({ allowed: true });

    const rejected = limiter.tryAcquire("a");
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("keeps separate buckets per key", () => {
    let t = 0;
    const limiter = createRateLimiter({ ratePerMinute: 60, burst: 1, now: () => t });

    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(false);

    expect(limiter.tryAcquire("b").allowed).toBe(true);
    expect(limiter.tryAcquire("b").allowed).toBe(false);
  });

  it("refills tokens over time at ratePerMinute", () => {
    let t = 0;
    const limiter = createRateLimiter({ ratePerMinute: 60, burst: 1, now: () => t });

    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(false);

    t += 1_000;
    expect(limiter.tryAcquire("a").allowed).toBe(true);

    t += 1_000;
    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(false);
  });

  it("caps accumulated tokens at burst size", () => {
    let t = 0;
    const limiter = createRateLimiter({ ratePerMinute: 60, burst: 2, now: () => t });

    t += 60_000;
    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(false);
  });

  it("defaults burst to ratePerMinute when omitted", () => {
    let t = 0;
    const limiter = createRateLimiter({ ratePerMinute: 2, now: () => t });

    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(true);
    expect(limiter.tryAcquire("a").allowed).toBe(false);
  });
});
