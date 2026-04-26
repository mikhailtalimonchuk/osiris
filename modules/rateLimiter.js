/**
 * Token-bucket rate limiter for API requests.
 * Configurable requests-per-minute with burst allowance.
 */

export class RateLimiter {
  /**
   * @param {number} maxRequestsPerMinute - Max sustained requests per minute (0 = unlimited)
   * @param {number} burstLimit - Max burst requests before throttling kicks in
   */
  constructor(maxRequestsPerMinute, burstLimit) {
    this.maxRpm = maxRequestsPerMinute;
    this.burstLimit = burstLimit ?? Math.max(5, Math.ceil(maxRequestsPerMinute / 6));
    this.tokens = this.burstLimit;
    this.lastRefill = Date.now();
    this.refillRate = maxRequestsPerMinute / 1000; // tokens per ms
  }

  /** Refill tokens based on elapsed time */
  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.burstLimit,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;
  }

  /**
   * Wait until a token is available, then consume it.
   * Returns immediately if rate limiting is disabled (maxRpm === 0).
   */
  async acquire() {
    if (this.maxRpm === 0) return; // unlimited

    while (true) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Sleep until at least 1 token should be available
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise(r => setTimeout(r, Math.min(waitMs, 2000)));
    }
  }

  /** Current token count (for debugging / /status) */
  get remaining() {
    this._refill();
    return Math.floor(this.tokens);
  }
}
