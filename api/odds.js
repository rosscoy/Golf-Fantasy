// ─── Odds API Proxy ──────────────────────────────────────────────────────────
// Proxies requests to The Odds API server-side to avoid CORS issues in the
// browser. Accepts:
//   GET /api/odds              → lists all sports
//   GET /api/odds?sport=X&...  → fetches odds for sport X with forwarded params
//
// The API key is kept server-side only.

import { rateLimit, getIp } from "./_rateLimit.js";

const ODDS_API_KEY = process.env.ODDS_API_KEY;

// Only these query params may be forwarded to The Odds API
const ALLOWED_PARAMS = new Set(["regions", "markets", "oddsFormat", "dateFormat"]);

// sport key must be lowercase alphanumeric + underscores only (e.g. "golf_pga")
const SPORT_RE = /^[a-z0-9_]{1,80}$/;

export default async function handler(req, res) {
  // Reject if API key is not configured
  if (!ODDS_API_KEY) {
    return res.status(503).json({ error: "Odds API not configured." });
  }

  // Rate limit: 30 requests per 15 minutes per IP
  const { allowed, retryAfter } = rateLimit(getIp(req), { max: 30, windowMs: 15 * 60 * 1000 });
  if (!allowed) {
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  // Only allow GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { sport, ...rest } = req.query;

  // Validate sport param if provided
  if (sport !== undefined && !SPORT_RE.test(sport)) {
    return res.status(400).json({ error: "Invalid sport parameter." });
  }

  const base = sport
    ? `https://api.the-odds-api.com/v4/sports/${sport}/odds/`
    : `https://api.the-odds-api.com/v4/sports/`;

  const url = new URL(base);
  url.searchParams.set("apiKey", ODDS_API_KEY);

  // Forward only whitelisted params with length cap
  for (const [k, v] of Object.entries(rest)) {
    if (ALLOWED_PARAMS.has(k) && typeof v === "string" && v.length <= 200) {
      url.searchParams.set(k, v);
    }
  }

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();
    res.setHeader("Access-Control-Allow-Origin", "https://rc-golf-sweeps.vercel.app");
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: `Upstream fetch failed: ${e.message}` });
  }
}
