// ─── Lock Reminder Emails ────────────────────────────────────────────────────
// Runs every hour via Vercel cron. Checks all scheduled auto-lock times and
// sends reminder emails to all registered users at 24h and 1h before lock.
//
// Required environment variables (set in Vercel dashboard):
//   RESEND_API_KEY          — from resend.com
//   FIREBASE_SERVICE_ACCOUNT — full JSON of your Firebase service account key
//   CRON_SECRET             — auto-set by Vercel, used to authenticate cron calls

import { rateLimit, getIp } from "./_rateLimit.js";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { Resend } from "resend";

const APP_URL = "https://rc-golf-sweeps.vercel.app";

function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  // Rate limit: 10 requests per 15 minutes per IP (secondary layer)
  const { allowed, retryAfter } = rateLimit(getIp(req), { max: 10, windowMs: 15 * 60 * 1000 });
  if (!allowed) {
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).end("Too many requests.");
  }

  // Vercel automatically passes CRON_SECRET in the Authorization header
  // for scheduled cron invocations. Reject anything else.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end("Unauthorized");
  }

  try {
    const app = getAdminApp();
    const db  = getFirestore(app);
    const auth = getAuth(app);
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Load all golfFantasy docs in one read
    const snapshot = await db.collection("golfFantasy").get();
    const docs = {};
    snapshot.forEach(d => { docs[d.id] = d.data().value; });

    const now = Date.now();
    const sent = [];

    // Check each autolock doc for upcoming lock windows
    for (const [key, value] of Object.entries(docs)) {
      if (!key.startsWith("autolock__") || !value?.time) continue;

      const tournamentId   = key.replace("autolock__", "");
      const lockTime       = new Date(value.time).getTime();
      const msUntilLock    = lockTime - now;
      // Sanitise tournament name: strip control chars (prevents email header injection)
      // and cap length before use in subject lines and HTML.
      const rawName = value.name || "Upcoming Tournament";
      const tournamentName = rawName.replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 100) || "Upcoming Tournament";

      // Skip if already locked or lock time has passed
      if (msUntilLock <= 0) continue;
      // Skip if picks are already locked in Firestore
      if (docs[`lock__${tournamentId}`]?.locked) continue;

      const windows = [
        {
          label:  "24h",
          min:    21 * 3600000,  // 21–27h window catches most tee times ±3h of cron run
          max:    27 * 3600000,
          subject: `⛳ Picks lock tomorrow — ${tournamentName}`,
          urgency: "tomorrow",
        },
      ];

      for (const window of windows) {
        if (msUntilLock < window.min || msUntilLock > window.max) continue;

        const reminderKey = `reminder__${tournamentId}__${window.label}`;
        if (docs[reminderKey]) continue; // already sent this reminder

        // Get all registered users
        const { users } = await auth.listUsers();
        const emails = users.filter(u => u.email).map(u => u.email);

        if (emails.length === 0) continue;

        // Send individual emails (Resend free tier doesn't support bulk send)
        for (const email of emails) {
          await resend.emails.send({
            from:    "RC Golf Sweeps <onboarding@resend.dev>",
            to:      email,
            subject: window.subject,
            html:    buildEmailHtml(tournamentName, window.urgency, APP_URL),
          });
        }

        // Mark as sent so this window isn't triggered again
        await db.collection("golfFantasy").doc(reminderKey).set({
          value:     { sentAt: now, recipients: emails.length },
          updatedAt: now,
        });

        sent.push({ tournamentId, window: window.label, recipients: emails.length });
      }
    }

    return res.json({ ok: true, checked: Object.keys(docs).filter(k => k.startsWith("autolock__")).length, sent });
  } catch (err) {
    console.error("send-reminders error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function buildEmailHtml(tournamentName, urgency, appUrl) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:520px;background:#fff;border-radius:6px;border:1px solid #d4b96a;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:#1a3a1a;padding:24px 32px;text-align:center;">
              <div style="font-family:'Georgia',serif;font-size:1.5rem;color:#c9a84c;letter-spacing:0.06em;">⛳ RC Golf Sweeps</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 12px;font-size:1.2rem;color:#1a3a1a;">${tournamentName}</h2>
              <p style="margin:0 0 20px;font-size:1rem;color:#333;line-height:1.6;">
                Picks for <strong>${tournamentName}</strong> lock <strong>${urgency}</strong>.
                Make sure your team is saved before the deadline — you can still swap players until then.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#1a3a1a;border-radius:4px;padding:12px 28px;">
                    <a href="${appUrl}" style="color:#c9a84c;font-family:Georgia,serif;font-size:1rem;text-decoration:none;letter-spacing:0.04em;">Save My Picks →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f5f0e8;padding:16px 32px;font-size:0.78rem;color:#888;border-top:1px solid #e0d8c8;">
              You're receiving this because you're part of RC Golf Sweeps.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
