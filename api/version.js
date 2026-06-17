export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ version: process.env.VERCEL_GIT_COMMIT_SHA || "unknown" });
}
