function createRateLimiter({ ratePerMinute, burst, now = Date.now } = {}) {
  if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) {
    throw new Error("createRateLimiter: ratePerMinute must be a positive number");
  }
  const capacity = Number.isFinite(burst) && burst > 0 ? burst : ratePerMinute;
  const tokensPerMs = ratePerMinute / 60_000;
  const buckets = new Map();

  function refill(bucket, t) {
    const elapsed = Math.max(0, t - bucket.lastRefill);
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * tokensPerMs);
      bucket.lastRefill = t;
    }
  }

  function tryAcquire(key) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: t };
      buckets.set(key, bucket);
    } else {
      refill(bucket, t);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const missing = 1 - bucket.tokens;
    const retryAfterMs = missing / tokensPerMs;
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { allowed: false, retryAfterSec };
  }

  return { tryAcquire };
}

module.exports = { createRateLimiter };
