// ─── In-Memory Rate Limiter ───────────────────────────────────────────────────
// Tracks request counts per key within a sliding window.
// State is held in module-level Maps, so it persists across requests within the
// same warm serverless instance but resets on cold starts. For this low-traffic
// private app that tradeoff is acceptable — Firebase / CRON_SECRET provide the
// primary access controls; this is a secondary abuse-prevention layer.

const buckets = new Map();

/**
 * Check and record a request against a rate limit.
 *
 * @param {string} key      - Unique identifier (e.g. IP address)
 * @param {number} max      - Max requests allowed in the window
 * @param {number} windowMs - Window duration in milliseconds
 * @returns {{ allowed: boolean, remaining: number, retryAfter?: number }}
 */
export function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now > existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1 };
  }

  if (existing.count >= max) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  existing.count++;
  return { allowed: true, remaining: max - existing.count };
}

/**
 * Extract the real client IP from a Vercel request, handling proxies.
 */
export function getIp(req) {
  // x-vercel-forwarded-for is set by Vercel's infrastructure and cannot be
  // spoofed by the caller. x-forwarded-for can be faked, so we only fall back
  // to it when running outside Vercel (e.g. local dev).
  return req.headers["x-vercel-forwarded-for"]
    || (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";
}
