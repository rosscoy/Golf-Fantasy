// ─────────────────────────────────────────────────────────────────────────────
// SETUP INSTRUCTIONS
// ─────────────────────────────────────────────────────────────────────────────
// 1. In your project folder, run:
//      npm install firebase
// 2. Replace src/App.jsx with this file.
// 3. That's it — Firebase config below is already wired up.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs,
} from "firebase/firestore";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile, GoogleAuthProvider, signInWithPopup,
  sendPasswordResetEmail,
} from "firebase/auth";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

// ─── Firebase Setup ───────────────────────────────────────────────────────────
// Values are injected at build time from VITE_* environment variables.
// Set them in .env (local) or the Vercel dashboard (production).
// Firebase web config is intentionally public — security comes from Firestore rules.
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseApp = initializeApp(firebaseConfig);
const db      = getFirestore(firebaseApp);
const auth    = getAuth(firebaseApp);
const storage = getStorage(firebaseApp);

// ─── Firestore Helpers ────────────────────────────────────────────────────────
// All golf data lives under /golfFantasy/... so it never clashes with the
// World Cup app which uses /users/... and /meta/...
const store = {
  async get(key) {
    try {
      const snap = await getDoc(doc(db, "golfFantasy", key));
      return snap.exists() ? snap.data().value : null;
    } catch { return undefined; } // undefined = read error; null = doc doesn't exist
  },
  async set(key, val) {
    try {
      await setDoc(doc(db, "golfFantasy", key), { value: val, updatedAt: Date.now() });
      return true;
    } catch (e) { console.error("store.set failed", key, e); return false; }
  },
  async del(key) {
    try { await deleteDoc(doc(db, "golfFantasy", key)); } catch {}
  },
  // Fetch all docs whose ID starts with a given prefix
  async getByPrefix(prefix) {
    try {
      const snap = await getDocs(collection(db, "golfFantasy"));
      const result = {};
      snap.forEach(d => {
        if (d.id.startsWith(prefix)) result[d.id] = d.data().value;
      });
      return result;
    } catch { return {}; }
  },
};

// ─── Activity Logging ─────────────────────────────────────────────────────────
// Writes a structured event to Firestore for admin review.
// Keys: activityLog__{userId}__{timestamp}
async function logActivity(userId, userEmail, action, details = {}) {
  try {
    const key = `activityLog__${userId}__${Date.now()}`;
    await setDoc(doc(db, "golfFantasy", key), {
      value: { userId, userEmail, action, details, timestamp: Date.now() },
      updatedAt: Date.now(),
    });
  } catch {}
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ADMIN_EMAIL   = "rosscoy95@gmail.com";
const MAX_PICKS     = 5;
const ENTRY_FEE     = 18; // € per person added to prize pot
const ADMIN_FEE     =  2; // € per person retained as admin fee (not in pot)
const TOTAL_FEE     = ENTRY_FEE + ADMIN_FEE; // € total collected per person (for payment tracking)
const MAX_PRIZE_POSITIONS = 10;
const MIN_BOTTOM_PRIZE    = 20; // € — never pay a position less than this

// Display times in Ireland local time (handles GMT/BST automatically)
const DISPLAY_TZ = "Europe/Dublin";
const tzLabel = () => new Intl.DateTimeFormat("en-GB", { timeZone: DISPLAY_TZ, timeZoneName: "short" })
  .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "GMT";

// Compute prize percentages for N positions. 1st is always 40%; the remaining
// 60% is divided among positions 2..N using linearly-decreasing weights so
// higher finishes always earn more. Returns array of integers summing to 100.
function computePrizeSplits(n) {
  if (n <= 1) return [100];
  const otherCount = n - 1;
  // weights: position 2 gets weight (otherCount), last position gets weight 1
  const weights = Array.from({ length: otherCount }, (_, i) => otherCount - i);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const otherPcts = weights.map(w => Math.round(w / weightSum * 60));
  // Fix rounding so other positions sum to exactly 60
  const diff = 60 - otherPcts.reduce((a, b) => a + b, 0);
  otherPcts[otherPcts.length - 1] += diff;
  return [40, ...otherPcts];
}
const defaultPrizePositions = n => n < 6 ? 2 : n < 11 ? 3 : n < 16 ? 4 : n < 21 ? 5 : Math.min(6 + Math.floor((n - 21) / 5), MAX_PRIZE_POSITIONS);
const MAJORS        = ["masters", "u.s. open", "us open", "the open championship", "the open", "pga championship", "masters tournament"];

// ─── Tier System ─────────────────────────────────────────────────────────────
const TIER_MIN_SUM = 13;
const TIER_BANDS = [
  { tier: 1, label: "Tier 1", min: 1,   max: 10,  color: "#c9a84c", bg: "#2a2000" },
  { tier: 2, label: "Tier 2", min: 11,  max: 25,  color: "#a0c878", bg: "#182810" },
  { tier: 3, label: "Tier 3", min: 26,  max: 50,  color: "#78b0d8", bg: "#101828" },
  { tier: 4, label: "Tier 4", min: 51,  max: 100, color: "#c89878", bg: "#281808" },
  { tier: 5, label: "Tier 5", min: 101, max: 9999, color: "#a090a0", bg: "#201820" },
];

// Odds-based tier cutoffs: position in the outright odds market (1 = favourite)
const TIER_ODDS_BANDS = [
  { tier: 1, min: 1,  max: 5  },
  { tier: 2, min: 6,  max: 15 },
  { tier: 3, min: 16, max: 35 },
  { tier: 4, min: 36, max: 70 },
  { tier: 5, min: 71, max: 9999 },
];

// ─── Nationality Flags ────────────────────────────────────────────────────────
const NATIONALITIES = [
  { name: "Argentina",        flag: "🇦🇷", code: "ar" },
  { name: "Australia",        flag: "🇦🇺", code: "au" },
  { name: "Belgium",          flag: "🇧🇪", code: "be" },
  { name: "Brazil",           flag: "🇧🇷", code: "br" },
  { name: "Canada",           flag: "🇨🇦", code: "ca" },
  { name: "Catalonia",        flag: "🏴󠁥󠁳󠁣󠁴󠁿", code: null, url: "/catalonia-flag.png" },
  { name: "Denmark",          flag: "🇩🇰", code: "dk" },
  { name: "England",          flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", code: "gb-eng" },
  { name: "Finland",          flag: "🇫🇮", code: "fi" },
  { name: "France",           flag: "🇫🇷", code: "fr" },
  { name: "Germany",          flag: "🇩🇪", code: "de" },
  { name: "Ireland",          flag: "🇮🇪", code: "ie" },
  { name: "Italy",            flag: "🇮🇹", code: "it" },
  { name: "Japan",            flag: "🇯🇵", code: "jp" },
  { name: "Mexico",           flag: "🇲🇽", code: "mx" },
  { name: "Netherlands",      flag: "🇳🇱", code: "nl" },
  { name: "New Zealand",      flag: "🇳🇿", code: "nz" },
  { name: "Northern Ireland", flag: "🇬🇧", code: "gb-nir" },
  { name: "Norway",           flag: "🇳🇴", code: "no" },
  { name: "Portugal",         flag: "🇵🇹", code: "pt" },
  { name: "Scotland",         flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", code: "gb-sct" },
  { name: "South Africa",     flag: "🇿🇦", code: "za" },
  { name: "South Korea",      flag: "🇰🇷", code: "kr" },
  { name: "Spain",            flag: "🇪🇸", code: "es" },
  { name: "Sweden",           flag: "🇸🇪", code: "se" },
  { name: "United States",    flag: "🇺🇸", code: "us" },
  { name: "Wales",            flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", code: "gb-wls" },
];

function getNatCode(nationality) {
  if (!nationality) return null;
  const n = NATIONALITIES.find(x => x.name === nationality);
  return n ? n.code : null;
}

function NatFlag({ nationality, size = 20 }) {
  const n = NATIONALITIES.find(x => x.name === nationality);
  if (!n) return null;
  const h = Math.round(size * 0.75);
  const src = n.url || (n.code ? `https://flagcdn.com/w${size}/${n.code}.png` : null);
  const srcSet = !n.url && n.code ? `https://flagcdn.com/w${size * 2}/${n.code}.png 2x` : undefined;
  if (!src) return null;
  return (
    <img
      src={src}
      srcSet={srcSet}
      width={size}
      height={h}
      alt={nationality}
      title={nationality}
      style={{ display:"inline-block", verticalAlign:"middle", borderRadius:"1px" }}
      onError={e => { e.currentTarget.style.display = "none"; }}
    />
  );
}

function getTierForRank(rank) {
  if (!rank) return 3; // default for unranked
  const band = TIER_BANDS.find(b => rank >= b.min && rank <= b.max);
  return band ? band.tier : 5;
}

function getTierForOddsPosition(pos) {
  if (!pos) return 3;
  const band = TIER_ODDS_BANDS.find(b => pos >= b.min && pos <= b.max);
  return band ? band.tier : 5;
}

// Normalise a player name for fuzzy matching across data sources
function normName(name) {
  return (name || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function getTierInfo(tier) {
  return TIER_BANDS.find(b => b.tier === tier) || TIER_BANDS[2];
}

// Fetch world rankings from ESPN rankings page via a CORS proxy
// Rankings are cached in Firestore for 24h to avoid hammering ESPN
// ─── Static World Rankings (ESPN top 200, updated March 2026) ───────────────
// Update this periodically by checking https://www.espn.com/golf/rankings
const WORLD_RANKINGS = {
  "9478": 1,    // Scottie Scheffler
  "3470": 2,    // Rory McIlroy
  "4425906": 3, // Cameron Young
  "9037": 4,    // Matt Fitzpatrick
  "10592": 5,   // Collin Morikawa
  "5539": 6,    // Tommy Fleetwood
  "569": 7,     // Justin Rose
  "10166": 8,   // J.J. Spaun
  "5409": 9,    // Russell Henley
  "4690755": 10, // Chris Gotterup
  "10140": 11,  // Xander Schauffele
  "11378": 12,  // Robert MacIntyre
  "8961": 13,   // Sepp Straka
  "4404992": 14, // Ben Griffin
  "4375972": 15, // Ludvig Åberg
  "4848": 16,   // Justin Thomas
  "5860": 17,   // Hideki Matsuyama
  "3832": 18,   // Alex Noren
  "5054388": 19, // Jacob Bridgeman
  "9780": 20,   // Jon Rahm
  "5408": 21,   // Harris English
  "7081": 22,   // Si Woo Kim
  "4419142": 23, // Akshay Bhatia
  "5579": 24,   // Patrick Reed
  "4348470": 25, // Kristoffer Reitan
  "5553": 26,   // Tyrrell Hatton
  "4364873": 27, // Viktor Hovland
  "10046": 28,  // Bryson DeChambeau
  "11250": 29,  // Nicolai Højgaard
  "6007": 30,   // Patrick Cantlay
  "4410932": 31, // Min Woo Lee
  "4513": 32,   // Keegan Bradley
  "9530": 33,   // Maverick McNealy
  "10364": 34,  // Kurt Kitayama
  "9938": 35,   // Sam Burns
  "5076021": 36, // Ryan Gerard
  "3702": 37,   // Rickie Fowler
  "4587": 38,   // Shane Lowry
  "9843": 39,   // Jake Knapp
  "4585549": 40, // Marco Penge
  "1680": 41,   // Jason Day
  "9025": 42,   // Daniel Berger
  "4901368": 43, // Matt McCarty
  "10906": 44,  // Aaron Rai
  "8974": 45,   // Michael Kim
  "388": 46,    // Adam Scott
  "3550": 47,   // Gary Woodland
  "4408316": 48, // Nico Echavarria
  "4426181": 49, // Sam Stevens
  "9126": 50,   // Corey Conners
  "5467": 51,   // Jordan Spieth
  "4921329": 52, // Michael Brennan
  "1225": 53,   // Brian Harman
  "11332": 54,  // Andrew Novak
  "4837368": 55, // Pierceson Coody
  "4251": 56,   // Ryan Fox
  "4589438": 57, // Harry Hall
  "3792": 58,   // Nick Taylor
  "4858572": 59, // Ryo Hisatsune
  "4585548": 60, // Sami Välimäki
  "4837": 61,   // Thomas Detry
  "4895429": 62, // David Puig
  "4425904": 63, // Michael Thorbjornsen
  "11253": 64,  // Rasmus Højgaard
  "4604053": 65, // Jayden Schaper
  "5338": 66,   // Bud Cauley
  "11382": 67,  // Sungjae Im
  "9506": 68,   // Jordan Smith
  "10548": 69,  // Matt Wallace
  "11101": 70,  // Max Greyserman
  "11119": 71,  // Wyndham Clark
  "4610056": 72, // Casey Jarvis
  "6825": 73,   // Patrick Rodgers
  "5217048": 74, // Johnny Keefer
  "5080439": 75, // Aldrich Potgieter
  "10980": 76,  // Sahith Theegala
  "4858859": 77, // Rasmus Neergaard-Petersen
  "9484": 78,   // Alex Smalley
  "10505": 79,  // J.T. Poston
  "9221": 80,   // Haotong Li
  "11383": 80,  // Max McGreevy
  "5502": 82,   // Andrew Putnam
  "4364865": 83, // Alex Fitzpatrick
  "11056": 84,  // Austin Smotherman
  "11393": 85,  // Garrick Higgo
  "9658": 86,   // Taylor Pendrith
  "4671": 87,   // John Parry
  "11385": 88,  // Rico Hoey
  "10343": 89,  // Lucas Herbert
  "4691931": 90, // Ricky Castillo
  "6701": 91,   // David Lipsky
  "9243": 92,   // Christiaan Bezuidenhout
  "676": 93,    // Lucas Glover
  "4714133": 94, // Elvis Smylie
  "5057": 95,   // Shaun Norris
  "4425899": 96, // Daniel Hillier
  "4566443": 97, // Matti Schmid
  "3449": 98,   // Chris Kirk
  "10054": 99,  // Denny McCarthy
  "6937": 100,  // Stephan Jaeger
  "6962": 101,  // Adrien Saddier
  "1407": 102,  // Dan Brown
  "4791222": 103, // Mac Meissner
  "9525": 104,  // Brian Campbell
  "5143175": 105, // Sudarshan Yellamaraju
  "5956": 106,  // Andy Sullivan
  "5105333": 107, // Angel Ayora
  "4348444": 108, // Tom McKibbin
  "8906": 109,  // Keith Mitchell
  "5140": 110,  // Thorbjørn Olesen
  "4349547": 111, // Kevin Yu
  "4618114": 112, // Chandler Blanchet
  "4408324": 113, // Ian Holt
  "9143": 114,  // Mark Hubbard
  "5882": 115,  // Emiliano Grillo
  "10522": 116, // Eric Cole
  "1651": 117,  // Billy Horschel
  "5152205": 118, // Josele Ballester
  "2230": 119,  // Tony Finau
  "5211425": 120, // Blades Brown
  "4408320": 121, // Kevin Roy
  "9240": 122,  // Thriston Lawrence
  "8973": 123,  // Max Homa
  "6086": 124,  // Tom Hoge
  "6798": 125,  // Brooks Koepka
  "1030": 126,  // Jhonattan Vegas
  "4602218": 127, // Davis Thompson
  "4565467": 128, // Eugenio Chacarra
  "5550": 129,  // Laurie Canter
  "5081630": 130, // Dan Bradbury
  "1222": 131,  // Brandt Snedeker
  "5076025": 132, // William Mouw
  "4699418": 133, // Keita Nakajima
  "4426182": 134, // Steven Fisk
  "9374": 135,  // JC Ritchie
  "7169": 136,  // Nacho Elvira
  "4699290": 137, // Mikael Lindberg
  "5217198": 138, // Jacob Skov Olesen
  "4410612": 139, // Takumi Kanaya
  "10102": 140, // Calum Hill
  "10058": 141, // Davis Riley
  "4602673": 142, // Tom Kim
  "4408315": 143, // Vince Whaley
  "6931": 144,  // Mackenzie Hughes
  "11345": 145, // Travis Smyth
  "4698579": 146, // S.H. Kim
  "5102625": 147, // Martin Couvra
  "6011": 148,  // Beau Hossler
  "4404991": 149, // Lee Hodges
  "10664": 150, // Taylor Moore
  "4868733": 151, // Joe Highsmith
  "4597553": 152, // Kazuki Higa
  "5727": 153,  // Joakim Lagergren
  "5076011": 154, // Adrien Dumont de Chassart
  "10372": 155, // Adam Schenk
  "10057": 156, // Chad Ramey
  "10770": 157, // Oliver Lindell
  "5007892": 158, // Davis Lamb
  "5285": 159,  // Byeong Hun An
  "9963": 160,  // Scott Vincent
  "5830": 161,  // Dean Burmester
  "1674": 162,  // Peter Uihlein
  "10595": 163, // Jeremy Gandon
  "5147097": 164, // Karl Vilips
  "4425898": 165, // Austin Eckroat
  "4587989": 166, // Chandler Phillips
  "11099": 167, // Joaquín Niemann
  "10838": 168, // Ewen Ferguson
  "1694": 169,  // Julien Guerrier
  "4691": 170,  // Jorge Campillo
  "9928": 171,  // Marcus Armitage
  "5532": 172,  // Carlos Ortiz
  "5209442": 173, // Neal Shipley
  "9364": 174,  // Erik van Rooyen
  "10030": 175, // Zach Bauchou
  "4036": 176,  // Richard T. Lee
  "11143": 177, // Carson Young
  "257": 178,   // Matt Kuchar
  "9899": 179,  // Hennie Du Plessis
  "4407372": 180, // Antoine Rozner
  "5119683": 181, // Wenyi Ding
  "8889": 182,  // Zecheng Dou
  "6001": 183,  // Séamus Power
  "158": 184,   // Sergio García
  "1745": 184,  // Anthony Kim
  "5186648": 186, // Kazuma Kobori
  "11456": 187, // Doug Ghim
  "6958": 188,  // Grant Forrest
  "4358083": 189, // Patrick Fishburn
  "4372851": 190, // Taylor Montgomery
  "4425907": 191, // Alistair Docherty
  "5312609": 192, // Kota Kaneko
  "6196": 193,  // Joel Dahmen
  "4837224": 194, // Freddy Schott
  "5716": 195,  // Francesco Laporta
  "10238": 196, // Davis Bryant
  "5081684": 197, // Dylan Menante
  "5113335": 198, // Emilio González
  "4904295": 199, // Jay Card III
  "11183": 200  // Trace Crowe
};

// ─── Client-side Auth Rate Limiter ───────────────────────────────────────────
// Tracks failed login/register attempts per email in localStorage.
// Max 5 failures per 15 minutes — blocks further attempts and shows a countdown.
const AUTH_RL = { max: 5, windowMs: 15 * 60 * 1000 };

function _authRlKey(email) {
  // Base64-encode so special chars in emails don't break the key
  return `gf_rl__${btoa(email.toLowerCase().trim()).replace(/=/g, "")}`;
}

function checkAuthRateLimit(email) {
  try {
    const data = JSON.parse(localStorage.getItem(_authRlKey(email)) || "{}");
    const now = Date.now();
    if (!data.resetAt || now > data.resetAt) return { allowed: true };
    if ((data.count || 0) >= AUTH_RL.max) {
      return { allowed: false, minutesLeft: Math.ceil((data.resetAt - now) / 60000) };
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

function recordAuthFailure(email) {
  try {
    const key = _authRlKey(email);
    const now = Date.now();
    const data = JSON.parse(localStorage.getItem(key) || "{}");
    const resetAt = (!data.resetAt || now > data.resetAt) ? now + AUTH_RL.windowMs : data.resetAt;
    const count   = (!data.resetAt || now > data.resetAt) ? 1 : (data.count || 0) + 1;
    localStorage.setItem(key, JSON.stringify({ count, resetAt }));
  } catch {}
}

function clearAuthRateLimit(email) {
  try { localStorage.removeItem(_authRlKey(email)); } catch {}
}

// ─── Input Sanitization & Validation ─────────────────────────────────────────
// Returns null on success, an error string on failure.

/** Trim and hard-cap to maxLength. Always returns a string. */
function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/** Display name: 2–100 chars. */
function validateName(value) {
  const s = sanitizeText(value, 100);
  if (s.length < 2)  return "Name must be at least 2 characters.";
  if (s.length > 100) return "Name must be 100 characters or fewer.";
  return null;
}

/** Mobile: 7–20 chars, digits / spaces / + - ( ) only. */
function validateMobile(value) {
  const s = sanitizeText(value, 20);
  if (!/^[+\d\s\-().]{7,20}$/.test(s)) return "Enter a valid mobile number (7–20 digits).";
  return null;
}

/** Cut score: integer strictly in [-30, +30]. */
function validateCutScore(raw) {
  const n = parseInt(String(raw).replace(/[^0-9\-]/g, ""), 10);
  if (isNaN(n))        return "Cut score must be a number.";
  if (n < -30 || n > 30) return "Cut score must be between -30 and +30.";
  return null;
}

/** Auto-lock datetime: valid ISO-parseable date, must be in the future. */
function validateAutoLockDate(value) {
  if (!value || typeof value !== "string" || value.length > 40)
    return "Please select a valid date and time.";
  const d = new Date(value + ":00Z");
  if (isNaN(d.getTime()))       return "Invalid date/time format.";
  if (d.getTime() <= Date.now()) return "Auto-lock time must be in the future.";
  return null;
}

/** Photo upload: ≤ 2 MB, raster image types only (no SVG). */
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
function validatePhoto(file) {
  if (!file)                           return "No file selected.";
  if (file.size > 2 * 1024 * 1024)    return "Photo must be under 2 MB.";
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return "Only JPEG, PNG, GIF, or WebP images are allowed.";
  return null;
}

// Rankings are built from the static WORLD_RANKINGS lookup above.
// No async fetch needed — returns instantly.
function fetchWorldRankings() {
  return Object.entries(WORLD_RANKINGS).map(([id, rank]) => ({ id, name: "", rank }));
}

// ─── ESPN API ─────────────────────────────────────────────────────────────────
async function fetchTournaments() {
  try {
    const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
    const d = await r.json();
    // Use the calendar array (full season schedule) rather than d.events which ESPN
    // often leaves stuck on a stale completed event.
    const calendar = (d.leagues?.[0]?.calendar || []).map(entry => ({
      id:        entry.id,
      name:      entry.label,
      shortName: entry.label,
      date:      entry.startDate,
      endDate:   entry.endDate,
    }));
    return calendar.length > 0 ? calendar : (d.events || []);
  } catch { return []; }
}

// Parse competitors array (shared between both API response shapes)
function parseCompetitors(competitors) {
  // Determine how many rounds have been played — use rounds with actual score data
  // (ESPN returns empty shell objects for future rounds, so raw length is unreliable)
  const roundCounts = competitors.map(c => {
    const rounds = Array.isArray(c.linescores) ? c.linescores : [];
    return rounds.filter(r =>
      (r.linescores || []).length > 0 ||
      (r.displayValue && r.displayValue !== "-" && r.displayValue !== "0" && r.displayValue !== "E")
    ).length;
  });
  const maxRounds = Math.max(...roundCounts, 0);
  const cutHappened = maxRounds >= 3; // cut happens after round 2

  return competitors.map((c, idx) => {
    const name     = c.athlete?.displayName || c.athlete?.fullName || c.displayName || "Unknown";
    const scoreRaw = typeof c.score === "string" ? c.score
                   : (c.score?.displayValue ?? c.totalScore ?? "E");

    const statusStr  = (c.status?.displayName || c.status?.type?.name || c.status?.type || "").toLowerCase();
    const statusDesc = (c.status?.type?.description || "").toLowerCase();

    // Detect MC/WD from status string OR from having fewer rounds than leaders
    const statusSaysWD  = statusStr.includes("wd") || statusStr.includes("withdraw") || statusDesc.includes("withdraw");
    // "cut" on its own = missed cut; exclude "made cut" phrasing
    const statusSaysCut = (statusStr.includes("cut") && !statusStr.includes("made")) ||
                          statusStr.includes("mc") ||
                          (statusDesc.includes("cut") && !statusDesc.includes("made")) ||
                          statusDesc.includes("missed");
    const rounds = Array.isArray(c.linescores) ? c.linescores : [];
    // Count rounds with actual score data — ESPN often returns empty shell objects for R3/R4
    // for players who missed the cut, so we can't rely on rounds.length alone
    const playedRounds = rounds.filter(r =>
      (r.linescores || []).length > 0 ||
      (r.displayValue && r.displayValue !== "-" && r.displayValue !== "0" && r.displayValue !== "E")
    ).length;
    const roundsMissedCut = cutHappened && playedRounds > 0 && playedRounds <= 2;
    const isWD = statusSaysWD;
    const isMC = !isWD && (statusSaysCut || roundsMissedCut);

    const pos = c.status?.position?.displayName || (c.order ? String(c.order) : String(idx + 1));

    // Find the last round that has actual hole-by-hole data — ESPN always appends
    // an empty shell for the next round, so rounds.at(-1) is often blank.
    const activeRound = [...rounds].reverse().find(r => (r.linescores || []).length > 0) || null;
    const today = (isMC || isWD) ? "-" : (activeRound?.displayValue || "-");

    // Thru holes
    let thru;
    if (isMC) {
      thru = "MC";
    } else if (isWD) {
      thru = "WD";
    } else if (c.status?.thru?.displayValue) {
      // Leaderboard API shape provides this directly
      thru = c.status.thru.displayValue;
    } else if (activeRound) {
      const holeScores = activeRound.linescores || [];
      if (holeScores.length >= 18) {
        thru = "F";
      } else {
        thru = String(holeScores.length);
      }
    } else {
      thru = "-";
    }

    // Play status for dot colour — derived purely from hole data since status is
    // null in the scoreboard API.
    let playStatus;
    if (isMC || isWD) {
      playStatus = "cut_wd";
    } else if (!activeRound) {
      // No hole data at all — hasn't teed off yet
      playStatus = "not_started";
    } else {
      const holeCount = (activeRound.linescores || []).length;
      playStatus = holeCount >= 18 ? "finished" : "active";
    }

    return {
      id:           c.id || String(idx),
      name,
      rawScore:     parseScoreToNum(scoreRaw),
      score:        scoreRaw,
      position:     pos,
      thru,
      today,
      cut:          isMC,
      statusSaysCut, // true only when ESPN's status field explicitly says MC — more reliable than score/round-count
      withdrawn:    isWD,
      playStatus,
    };
  });
}

async function fetchLeaderboard(eventId, eventDate) {
  // Strategy 1: scoreboard?dates=YYYYMMDD — most reliable, same source as ESPN website
  // Strategy 2: leaderboard?event=ID — fallback, different response shape
  // We run both in parallel and keep whichever returns more players.

  // Build list of dates to try: Thu-Sun of tournament week + today
  const datesToTry = [];
  if (eventDate) {
    const start = new Date(eventDate);
    for (let i = 0; i <= 3; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      datesToTry.push(d.toISOString().slice(0,10).replace(/-/g,""));
    }
  }
  const todayStr = new Date().toISOString().slice(0,10).replace(/-/g,"");
  if (!datesToTry.includes(todayStr)) datesToTry.push(todayStr);

  const results = await Promise.allSettled([
    // Scoreboard strategy — try each date until we find competitors for this exact event
    (async () => {
      for (const dateStr of datesToTry) {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${dateStr}`);
          const d = await r.json();
          // Only match by exact event ID — never bleed another tournament's data in
          const ev = (d.events || []).find(e => String(e.id) === String(eventId));
          if (!ev) continue;
          const competitors = ev.competitions?.[0]?.competitors || [];
          if (competitors.length > 0) {
            // Fetch each competitor's scheduled tee time from the ESPN core API.
            // The site API competition date is always midnight ET (04:00 UTC) and
            // useless. The core API /status endpoint has an actual "teeTime" field.
            let firstTeeTime = null;
            try {
              const statusResults = await Promise.allSettled(
                competitors.map(c =>
                  fetch(
                    `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${eventId}/competitions/${eventId}/competitors/${c.id}/status?lang=en&region=us`
                  ).then(r => r.ok ? r.json() : null).catch(() => null)
                )
              );
              const teeMs = statusResults
                .filter(r => r.status === 'fulfilled' && r.value?.teeTime)
                .map(r => new Date(r.value.teeTime).getTime())
                .filter(t => !isNaN(t));
              if (teeMs.length > 0) firstTeeTime = new Date(Math.min(...teeMs)).toISOString();
            } catch {}
            return { players: parseCompetitors(competitors), espnCutScore: null, firstTeeTime };
          }
        } catch { continue; }
      }
      return { players: [], espnCutScore: null, firstTeeTime: null };
    })(),
    // Leaderboard endpoint (original approach, fallback)
    (async () => {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?event=${eventId}`);
      const d = await r.json();
      const competitors = d?.tournament?.competitors || [];
      if (competitors.length === 0) return { players: [], espnCutScore: null, firstTeeTime: null };
      let espnCutScore = null;
      const t = d?.tournament;
      if (t?.cutScore !== undefined && t.cutScore !== null) {
        espnCutScore = parseScoreToNum(t.cutScore);
      } else if (t?.cut?.score !== undefined && t.cut.score !== null) {
        espnCutScore = parseScoreToNum(t.cut.score);
      } else if (Array.isArray(t?.cuts) && t.cuts.length > 0) {
        // Some ESPN events return cuts as an array — take the first (primary) cut
        const c0 = t.cuts[0];
        const raw = c0?.cutScore ?? c0?.score ?? c0?.value;
        if (raw !== undefined && raw !== null) espnCutScore = parseScoreToNum(raw);
      } else if (t?.lines?.cut !== undefined) {
        espnCutScore = parseScoreToNum(t.lines.cut);
      }
      // tournament.startDate / tournament.date are just the tournament's calendar date
      // (midnight local time ≈ 04:00 UTC for ET events) — not an actual tee time.
      // Don't use them as firstTeeTime.
      return { players: parseCompetitors(competitors), espnCutScore, firstTeeTime: null };
    })(),
  ]);

  // Pick the result with more players; also gather firstTeeTime and espnCutScore from any result that has them
  let best = { players: [], espnCutScore: null, firstTeeTime: null };
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.players.length > best.players.length) {
      best = r.value;
    }
  }
  if (!best.firstTeeTime) {
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.firstTeeTime) {
        best.firstTeeTime = r.value.firstTeeTime;
        break;
      }
    }
  }
  // The scoreboard API never provides a cut score — grab it from whichever result has one
  if (best.espnCutScore === null) {
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.espnCutScore !== null) {
        best.espnCutScore = r.value.espnCutScore;
        break;
      }
    }
  }

  // If no cut score from API, estimate from scores of non-cut players
  if (best.espnCutScore === null && best.players.length > 0) {
    // Estimate cut score from the raw API competitors data
    // The cut score is the worst 36-hole (2-round) score among players who made the cut.
    // We stored the raw competitors so we can sum rounds 1+2 for made-cut players.
    const madecutPlayers = best.players.filter(p => !p.cut && !p.withdrawn);
    // Use the parsed rawScore as a last resort — but only if it looks like a 2-round score
    // (i.e. tournament is still in rounds 3-4, so rawScore is a running total not just R1+R2)
    // Better: just take the highest rawScore among made-cut players that is reasonable (<= +10)
    // since cut lines are rarely above +10
    if (madecutPlayers.length > 0) {
      const scores = madecutPlayers.map(p => p.rawScore);
      const worstMadecut = Math.max(...scores);
      // Sanity check: cut scores for PGA Tour events are typically between -10 and +6
      // If the calculated value is unreasonably high it means we're looking at final scores not cut scores
      // In that case don't set a cut score — admin can set it manually
      if (worstMadecut <= 8) {
        best.espnCutScore = worstMadecut;
      }
      // else: leave as null so admin override is required
    }
  }

  return best;
}

// ─── Scoring Logic ────────────────────────────────────────────────────────────
function applyScoreRules(player, cutScore) {
  if (cutScore === null || cutScore === undefined) {
    return { adjusted: player.rawScore, actualScore: player.rawScore, fantasyScore: null, penalised: false };
  }
  if (player.withdrawn) {
    const s = cutScore + 10;
    return { adjusted: s, actualScore: player.rawScore, fantasyScore: s, penalised: true };
  }
  // Trust ESPN's explicit status (statusSaysCut) as the authoritative MC signal.
  // ESPN also returns "CUT" as the score string for players who MADE the cut but
  // haven't started R3 yet, so score-string and round-count alone are unreliable.
  // Fall back to round-count only when the score is a real numeric value >= cut line.
  const scoreStr = String(player.score ?? "");
  const rawIsNonNumeric = scoreStr === "" || isNaN(parseInt(scoreStr.replace("+", ""), 10));
  const missedCut = player.statusSaysCut ||
    (player.cut && !rawIsNonNumeric && player.rawScore >= cutScore);
  if (missedCut) {
    const s = cutScore + 10;
    return { adjusted: s, actualScore: player.rawScore, fantasyScore: s, penalised: true };
  }
  const capped    = Math.min(player.rawScore, cutScore + 9);
  const wasCapped = capped < player.rawScore;
  return { adjusted: capped, actualScore: player.rawScore, fantasyScore: wasCapped ? capped : null, penalised: false };
}

// Format score for display in a table cell — shows both actual and fantasy if different
function formatScoreCell(actualScore, fantasyScore, penalised) {
  const actual = formatScore(actualScore);
  if (penalised && fantasyScore !== null) {
    // Show actual score struck through, fantasy score in red
    return { actual, fantasy: formatScore(fantasyScore), penalised: true };
  }
  if (fantasyScore !== null) {
    // Capped — show actual with asterisk note
    return { actual, fantasy: formatScore(fantasyScore), penalised: false, capped: true };
  }
  return { actual, fantasy: null, penalised: false };
}

function parseScoreToNum(val) {
  if (val === "E" || val === "0" || val === 0) return 0;
  if (typeof val === "number") return val;
  const n = parseInt(String(val).replace("+", ""), 10);
  return isNaN(n) ? 0 : n;
}

function formatScore(val) {
  if (val === 0) return "E";
  return val > 0 ? `+${val}` : `${val}`;
}

function isMajor(name = "") {
  const n = name.toLowerCase();
  return MAJORS.some(m => n.includes(m));
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Crimson+Text:ital,wght@0,400;0,600;1,400&family=EB+Garamond:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; max-width: 100%; }

  :root {
    --green-deep: #1a2e1a;
    --green-dark: #234823;
    --green-mid:  #2d5a27;
    --green-pale: #c8dfc4;
    --green-mist: #e8f0e6;
    --gold:       #c9a84c;
    --gold-light: #e8c96a;
    --gold-pale:  #f5e9c8;
    --cream:      #f7f3ec;
    --cream-dark: #ede5d4;
    --white:      #ffffff;
    --text-dark:  #1a1a14;
    --text-mid:   #3a3a2e;
    --text-light: #6b6b55;
    --red:        #b03a2e;
    --red-pale:   #fdf0f0;
    --shadow:     rgba(26,46,26,0.18);
    --shadow-deep:rgba(26,46,26,0.35);
  }

  html, body { overflow-x: hidden; }
  body { background: var(--cream); font-family: 'Crimson Text', Georgia, serif; color: var(--text-dark); min-height: 100vh; }
  .app  { min-height: 100vh; display: flex; flex-direction: column; }

  /* Header */
  .header { background: var(--green-deep); padding: 0 2rem; display: flex; align-items: center; justify-content: space-between; height: 72px; border-bottom: 3px solid var(--gold); box-shadow: 0 4px 20px var(--shadow-deep); position: sticky; top: 0; z-index: 100; }
  .header-logo { font-family: 'Playfair Display', serif; color: var(--gold); font-size: 1.4rem; font-weight: 400; letter-spacing: 0.04em; cursor: pointer; user-select: none; }
  .header-sub  { color: var(--green-pale); font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; font-family: 'EB Garamond', serif; margin-top: 2px; }
  .header-nav  { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
  .nav-btn { background: none; border: none; cursor: pointer; color: var(--green-pale); font-family: 'EB Garamond', serif; font-size: 0.88rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px 12px; border-radius: 2px; transition: color 0.2s, background 0.2s; white-space: nowrap; }
  .nav-btn:hover, .nav-btn.active { color: var(--gold); background: rgba(201,168,76,0.1); }
  .nav-btn.logout:hover { color: #e88; background: rgba(220,80,80,0.08); }
  .admin-badge { background: var(--gold); color: var(--green-deep); font-family: 'EB Garamond', serif; font-size: 0.66rem; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 8px; border-radius: 2px; font-weight: 700; }
  .main { flex: 1; max-width: 1200px; margin: 0 auto; width: 100%; padding: 2rem; }

  /* Auth */
  .auth-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--green-deep); position: relative; overflow: hidden; }
  .auth-bg { position: absolute; inset: 0; background: radial-gradient(ellipse at 30% 50%, rgba(45,90,39,0.5) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(201,168,76,0.08) 0%, transparent 50%); pointer-events: none; }
  .auth-card { background: var(--cream); border: 1px solid var(--cream-dark); border-radius: 4px; padding: 3rem 3.5rem; width: 420px; max-width: 94vw; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(201,168,76,0.2); }
  .auth-card::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, var(--gold), var(--gold-light), var(--gold)); border-radius: 4px 4px 0 0; }
  .auth-title    { font-family: 'Playfair Display', serif; font-size: 2rem; color: var(--green-deep); text-align: center; margin-bottom: 0.3rem; }
  .auth-subtitle { font-family: 'EB Garamond', serif; color: var(--text-light); text-align: center; font-size: 0.9rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 2.5rem; }
  .auth-tabs { display: flex; border-bottom: 2px solid var(--cream-dark); margin-bottom: 2rem; }
  .auth-tab  { flex: 1; padding: 0.6rem; text-align: center; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.9rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-light); border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
  .auth-tab.active { color: var(--green-dark); border-color: var(--green-dark); font-weight: 600; }
  .field       { margin-bottom: 1.4rem; }
  .field label { display: block; font-family: 'EB Garamond', serif; font-size: 0.82rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-light); margin-bottom: 6px; }
  .field input { width: 100%; padding: 0.65rem 0.9rem; border: 1px solid var(--cream-dark); border-radius: 2px; font-family: 'Crimson Text', serif; font-size: 1rem; color: var(--text-dark); background: var(--white); transition: border-color 0.2s; outline: none; }
  .field input:focus { border-color: var(--green-mid); box-shadow: 0 0 0 3px rgba(45,90,39,0.08); }
  .btn-primary { width: 100%; padding: 0.8rem; background: var(--green-deep); color: var(--gold); border: none; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 1rem; letter-spacing: 0.1em; text-transform: uppercase; transition: background 0.2s; margin-top: 0.5rem; }
  .btn-primary:hover { background: var(--green-dark); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .auth-error { background: var(--red-pale); border: 1px solid #f5c6c6; color: var(--red); padding: 0.7rem 1rem; border-radius: 2px; font-size: 0.9rem; margin-bottom: 1rem; }
  .auth-privacy { margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid var(--cream-dark); font-family: 'EB Garamond', serif; font-size: 0.78rem; color: var(--text-light); line-height: 1.5; text-align: center; }
  .auth-privacy a { color: var(--green-mid); cursor: pointer; text-decoration: underline; }

  /* App footer */
  .app-footer { padding: 1.2rem 2rem; border-top: 1px solid var(--cream-dark); background: var(--cream); text-align: center; font-family: 'EB Garamond', serif; font-size: 0.78rem; color: var(--text-light); }
  .app-footer a { color: var(--green-mid); cursor: pointer; text-decoration: underline; }

  /* Privacy modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .modal-box { background: var(--cream); border: 1px solid var(--cream-dark); border-radius: 4px; max-width: 540px; width: 100%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
  .modal-head { display: flex; justify-content: space-between; align-items: center; padding: 1.2rem 1.6rem; border-bottom: 1px solid var(--cream-dark); }
  .modal-head h2 { font-family: 'Playfair Display', serif; font-size: 1.2rem; color: var(--green-deep); margin: 0; }
  .modal-close { background: none; border: none; font-size: 1.4rem; cursor: pointer; color: var(--text-light); padding: 0 4px; line-height: 1; }
  .modal-body { padding: 1.4rem 1.6rem; font-family: 'EB Garamond', serif; font-size: 0.92rem; color: var(--text-dark); line-height: 1.7; }
  .modal-body h3 { font-family: 'Playfair Display', serif; font-size: 1rem; color: var(--green-deep); margin: 1.2rem 0 0.4rem; }
  .modal-body h3:first-child { margin-top: 0; }
  .modal-body p { margin: 0 0 0.6rem; }
  .modal-body ul { margin: 0 0 0.6rem; padding-left: 1.4rem; }
  .modal-body a { color: var(--green-mid); }

  /* Page titles */
  .page-title    { font-family: 'Playfair Display', serif; font-size: 2rem; color: var(--green-deep); margin-bottom: 0.4rem; word-break: break-word; }
  .page-subtitle { font-family: 'EB Garamond', serif; color: var(--text-light); font-size: 0.88rem; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 2rem; }
  .tab-bar { display: flex; border-bottom: 2px solid var(--cream-dark); margin-bottom: 1.5rem; }
  .tab     { padding: 0.7rem 1.4rem; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-light); border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
  .tab.active { color: var(--green-dark); border-color: var(--green-dark); }

  /* Tournament cards */
  .tournaments-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
  .t-card       { background: var(--white); border: 1px solid var(--cream-dark); border-radius: 4px; overflow: hidden; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; box-shadow: 0 2px 8px rgba(26,46,26,0.07); }
  .t-card:hover { transform: translateY(-3px); box-shadow: 0 10px 32px rgba(26,46,26,0.16); }
  .t-card.major { border-top: 3px solid var(--gold); }
  .t-head  { background: var(--green-deep); padding: 1.2rem 1.4rem; }
  .t-badge { display: inline-block; background: var(--gold); color: var(--green-deep); font-family: 'EB Garamond', serif; font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; padding: 2px 8px; border-radius: 2px; margin-bottom: 6px; font-weight: 600; }
  .t-name  { font-family: 'Playfair Display', serif; color: var(--white); font-size: 1.05rem; line-height: 1.3; }
  .t-body  { padding: 1.2rem 1.4rem; }
  .t-meta  { display: flex; gap: 1.5rem; margin-bottom: 0.8rem; }
  .t-meta-item        { font-family: 'EB Garamond', serif; font-size: 0.82rem; color: var(--text-light); }
  .t-meta-item strong { display: block; color: var(--text-dark); font-size: 0.9rem; }
  .pill           { display: inline-block; font-family: 'EB Garamond', serif; font-size: 0.74rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; border-radius: 20px; }
  .pill.live      { background: #e8f5e2; color: #2d6a1f; border: 1px solid #b8dba8; }
  .pill.upcoming  { background: var(--gold-pale); color: #7a5a10; border: 1px solid #d4b96a; }
  .pill.completed { background: #f0f0f0; color: #666; border: 1px solid #ddd; }
  .pill.next-up   { background: #1a3a1a; color: #90d090; border: 1px solid #4a8a4a; animation: pulseNextUp 2s ease-in-out infinite; }
  @keyframes pulseNextUp {
    0%, 100% { box-shadow: 0 0 0 0 rgba(74,138,74,0.5); }
    50%       { box-shadow: 0 0 0 5px rgba(74,138,74,0); }
  }
  .t-card.next { border-color: #4a8a4a; }

  /* Picks layout */
  .picks-layout { display: grid; grid-template-columns: 1fr 340px; gap: 2rem; align-items: start; }
  .picks-team-card { align-self: stretch; }
  @media (max-width: 860px) {
    .picks-layout { display: grid; grid-template-columns: 1fr; width: 100%; gap: 0.75rem; }
    .picks-team-card { order: -1; width: 100%; align-self: stretch; }
    .picks-layout > div { width: 100%; min-width: 0; }
  }

  /* ── Mobile styles ────────────────────────────────────────────────────── */
  @media (max-width: 640px) {
    /* Header */
    .header { padding: 0 1rem; height: 56px; }
    .header-logo { font-size: 1.1rem; }
    .header-nav { gap: 0.3rem; }
    .nav-btn { font-size: 0.75rem; padding: 5px 7px; letter-spacing: 0.03em; }
    .admin-badge { font-size: 0.6rem; padding: 2px 5px; }

    /* Main padding */
    .main { padding: 0.75rem; }
    .app { overflow-x: hidden; }

    /* Page titles */
    .page-title { font-size: 1.3rem; word-break: break-word; }
    .page-subtitle { font-size: 0.78rem; margin-bottom: 1.2rem; }
    /* Ensure nothing bleeds outside viewport */
    .section-card, .team-card, .admin-panel, .lock-banner, .cut-banner,
    .comp-lb, .tournaments-grid, .picks-layout, .tab-bar { width: 100%; box-sizing: border-box; }
    /* Inline-tag wrapping on tournament header */
    .page-title + div { flex-wrap: wrap; }

    /* Tabs */
    .tab-bar { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap; }
    .tab { font-size: 0.75rem; padding: 0.55rem 0.8rem; white-space: nowrap; }

    /* Tournament cards — single column */
    .tournaments-grid { grid-template-columns: 1fr; gap: 1rem; }

    /* Section card header */
    .s-head { flex-direction: column; align-items: flex-start; gap: 0.5rem; padding: 0.8rem 1rem; }
    .s-head-title { font-size: 0.95rem; }

    /* Leaderboard table — compact padding on mobile */
    .lb-table th, .lb-table td { padding: 0.45rem 0.5rem; font-size: 0.8rem; }
    .lb-table .col-pos { width: 18px; }
    .name-c { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Hide actual score column on mobile — Fantasy col is sufficient */
    .col-score { display: none; }
    /* (pick-btn / btn-full / btn-icon overrides are at end of CSS to win cascade) */

    /* Search */
    .search-wrap { padding: 0.6rem 0.8rem; }

    /* Team card */
    .team-card { position: sticky; top: 56px; }
    .t-slot { padding: 0.55rem 0.9rem; }
    .t-slot-name { font-size: 0.88rem; }

    /* Admin panel */
    .admin-panel { padding: 1rem; }
    .admin-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .cut-input-sm { width: 80px; }

    /* Competition leaderboard */
    .c-row { grid-template-columns: 56px 1fr auto; padding: 0.65rem 0.8rem; }
    .c-user small { display: flex; flex-wrap: wrap; column-gap: 8px; row-gap: 2px; font-size: 0.68rem; margin-top: 3px; }
    .c-rank { display: flex; align-items: center; flex-wrap: nowrap; gap: 3px; }

    /* Back button */
    .back-btn { font-size: 0.78rem; margin-bottom: 1rem; }

    /* Lock / cut banners */
    .lock-banner, .cut-banner { font-size: 0.82rem; padding: 0.75rem 1rem; }

    /* Picks count badge in header */
    .picks-count-badge { display: none; }
    /* Hide username on small screens to prevent overflow */
    .nav-user { display: none; }
    /* On very small screens, shorten nav labels */
    .nav-btn { font-size: 0.7rem; padding: 4px 5px; }
  }
  .section-card { background: var(--white); border: 1px solid var(--cream-dark); border-radius: 4px; overflow: visible; width: 100%; min-width: 0; box-shadow: 0 2px 10px rgba(26,46,26,0.07); }
  .s-head       { background: var(--green-deep); padding: 1rem 1.4rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; min-width: 0; border-radius: 4px 4px 0 0; }
  .s-head-title { font-family: 'Playfair Display', serif; color: var(--white); font-size: 1.05rem; }
  .s-head-sub   { font-family: 'EB Garamond', serif; color: var(--green-pale); font-size: 0.76rem; letter-spacing: 0.04em; }
  .picks-count-badge { font-family: 'EB Garamond', serif; font-size: 0.8rem; color: var(--gold-light); letter-spacing: 0.06em; }

  /* Table */
  .lb-table    { width: 100%; border-collapse: collapse; }
  .lb-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; width: 100%; }
  .lb-table th { font-family: 'EB Garamond', serif; font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-light); padding: 0.6rem 0.8rem; border-bottom: 2px solid var(--cream-dark); text-align: left; background: var(--cream); white-space: nowrap; }
  .lb-table td { padding: 0.52rem 0.8rem; border-bottom: 1px solid var(--cream-dark); font-size: 0.9rem; vertical-align: middle; }
  .lb-table tr:hover td          { background: var(--green-mist); cursor: pointer; }
  .lb-table tr.is-picked td      { background: rgba(201,168,76,0.22); border-left: 3px solid var(--gold); }
  .lb-table tr.is-picked:hover td{ background: rgba(201,168,76,0.32); }
  .lb-table tr.is-picked .name-c { color: var(--green-deep); font-weight: 700; }
  .lb-table tr.is-cut td         { opacity: 0.4; }
  .pos-c  { font-family: 'EB Garamond', serif; color: var(--text-light); font-size: 0.8rem; width: 22px; text-align: center; }
  .name-c { font-family: 'Crimson Text', serif; font-weight: 600; }
  .player-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; flex-shrink: 0; vertical-align: middle; position: relative; top: -1px; }
  .dot-green  { background: #4caf50; box-shadow: 0 0 4px #4caf5088; }
  .dot-grey   { background: #aaaaaa; }
  .dot-blue   { background: #5b9bd5; }
  .dot-red    { background: #e05050; }
  .su { color: #2d6a1f; font-family: 'Playfair Display', serif; font-weight: 600; }
  .so { color: var(--red); font-family: 'Playfair Display', serif; font-weight: 600; }
  .se { color: var(--text-mid); font-family: 'Playfair Display', serif; font-weight: 600; }
  .pick-btn { background: none; border: 1px solid var(--cream-dark); border-radius: 2px; cursor: pointer; padding: 3px 10px; font-family: 'EB Garamond', serif; font-size: 0.74rem; letter-spacing: 0.06em; color: var(--text-light); transition: all 0.15s; white-space: nowrap; }
  .btn-full { display: inline; }
  .btn-icon { display: none; }
  .pick-btn:hover:not(:disabled) { border-color: var(--green-mid); color: var(--green-dark); background: var(--green-mist); }
  .pick-btn.on { background: var(--gold); border-color: var(--gold); color: var(--green-deep); font-weight: 600; }
  .pick-btn:disabled { opacity: 0.28; cursor: not-allowed; }
  .footnote { font-family: 'EB Garamond', serif; font-size: 0.76rem; color: var(--text-light); padding: 0.6rem 1.4rem; border-top: 1px solid var(--cream-dark); font-style: italic; }

  /* Team sidebar */
  .team-card  { background: var(--white); border: 1px solid var(--cream-dark); border-radius: 4px; overflow: visible; position: sticky; top: 88px; width: 100%; min-width: 0; box-shadow: 0 4px 16px rgba(26,46,26,0.1); }
  .team-head  { background: var(--green-deep); padding: 1rem 1.4rem; border-bottom: 2px solid var(--gold); border-radius: 4px 4px 0 0; }
  .team-title { font-family: 'Playfair Display', serif; color: var(--gold); font-size: 1.1rem; }
  .team-body  { padding: 0.8rem 1.4rem; }
  .t-slot       { display: flex; align-items: center; justify-content: space-between; padding: 0.52rem 0; border-bottom: 1px solid var(--cream-dark); min-height: 42px; }
  .t-slot:last-child { border-bottom: none; }
  .t-slot-name  { font-family: 'Crimson Text', serif; font-size: 0.9rem; font-weight: 600; line-height: 1.2; }
  .t-slot-tag   { font-size: 0.66rem; color: #999; font-family: 'EB Garamond', serif; }
  .t-slot-empty { color: var(--text-light); font-style: italic; font-family: 'Crimson Text', serif; font-size: 0.86rem; }
  .t-remove       { background: none; border: none; cursor: pointer; color: var(--text-light); font-size: 1.1rem; padding: 0 4px; line-height: 1; transition: color 0.15s; }
  .t-remove:hover { color: var(--red); }
  .team-total       { background: var(--green-deep); padding: 0.9rem 1.4rem; display: flex; justify-content: space-between; align-items: center; }
  .team-total-label { font-family: 'EB Garamond', serif; color: var(--green-pale); font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .team-total-score { font-family: 'Playfair Display', serif; font-size: 1.4rem; font-weight: 700; }
  .btn-save { width: 100%; padding: 0.75rem; background: var(--gold); color: var(--green-deep); border: none; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.9rem; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; transition: background 0.2s; }
  .btn-save:hover:not(:disabled) { background: var(--gold-light); }
  .btn-save:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Lock / reveal banners */
  .lock-banner { display: flex; align-items: flex-start; gap: 12px; background: #2c1a1a; border: 1px solid #7a2e2e; border-radius: 4px; padding: 1rem 1.4rem; margin-bottom: 1.5rem; color: #f5c6c6; font-family: 'EB Garamond', serif; font-size: 0.9rem; }
  .lock-banner strong { color: #f0a0a0; font-size: 0.98rem; display: block; margin-bottom: 3px; }

  /* Cut banner */
  .cut-banner  { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--gold-pale); border: 1px solid #d4b96a; border-radius: 4px; padding: 0.75rem 1.2rem; margin-bottom: 1.2rem; flex-wrap: wrap; }
  .cut-info    { font-family: 'EB Garamond', serif; font-size: 0.86rem; color: #7a5a10; }
  .cut-info strong { font-size: 0.98rem; color: #5a3e08; }

  /* Admin panel */
  .admin-panel       { background: #111a11; border: 1px solid var(--gold); border-radius: 4px; padding: 1.4rem 1.6rem; margin-bottom: 2rem; }
  .admin-panel-title { font-family: 'Playfair Display', serif; color: var(--gold); font-size: 1rem; margin-bottom: 0; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; padding: 0.2rem 0; }
  .admin-panel-title:hover { color: var(--gold-light); }
  .admin-panel .admin-section:first-of-type { margin-top: 1.2rem; }
  .admin-section     { margin-bottom: 1.1rem; padding-bottom: 1.1rem; border-bottom: 1px solid rgba(201,168,76,0.15); }
  .admin-section:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
  .admin-label { font-family: 'EB Garamond', serif; font-size: 0.78rem; letter-spacing: 0.1em; text-transform: uppercase; color: #9a8850; margin-bottom: 8px; }
  .admin-row   { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .status-dot       { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-dot.red   { background: #e06060; }
  .status-dot.green { background: #60c060; }
  .status-dot.amber { background: #c9a84c; }
  .status-text { font-family: 'Crimson Text', serif; font-size: 0.9rem; }
  .btn-lock   { padding: 6px 18px; background: #6e1e1e; color: #f5c6c6; border: 1px solid #9e3e3e; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; transition: background 0.15s; }
  .btn-lock:hover   { background: #8e2e2e; }
  .btn-unlock { padding: 6px 18px; background: #1a3a1a; color: #a0d0a0; border: 1px solid #3a6a3a; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; transition: background 0.15s; }
  .btn-unlock:hover { background: #234823; }
  .btn-reveal { padding: 6px 18px; background: #1a3060; color: #a0c0f0; border: 1px solid #3a5090; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; transition: background 0.15s; }
  .btn-reveal:hover { background: #253a7a; }
  .btn-hide   { padding: 6px 18px; background: #3a2a10; color: #d0b060; border: 1px solid #6a5020; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; transition: background 0.15s; }
  .btn-hide:hover { background: #4a3820; }
  .cut-input-sm { width: 68px; padding: 4px 8px; border: 1px solid #5a7a3a; border-radius: 2px; font-family: 'Crimson Text', serif; font-size: 0.9rem; background: #1a2a1a; color: var(--gold-light); outline: none; text-align: center; }
  .cut-input-sm::placeholder { color: #5a6a4a; }
  .cut-input-sm:focus { border-color: var(--gold); }
  .btn-sm      { padding: 4px 12px; background: var(--green-dark); color: var(--gold); border: none; border-radius: 2px; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.76rem; letter-spacing: 0.06em; text-transform: uppercase; transition: background 0.15s; }
  .btn-sm:hover{ background: var(--green-mid); }
  .btn-sm.warn { background: #5a2020; color: #f0b0b0; }
  .btn-sm.warn:hover { background: #7a2828; }

  /* Competition leaderboard */
  .comp-lb   { background: var(--white); border: 1px solid var(--cream-dark); border-radius: 4px; overflow: visible; box-shadow: 0 2px 10px rgba(26,46,26,0.07); }
  .c-row     { display: grid; grid-template-columns: 60px 1fr auto; align-items: center; padding: 0.8rem 1.4rem; border-bottom: 1px solid var(--cream-dark); }
  .c-row.hdr { background: var(--cream); border-radius: 4px 4px 0 0; }
  .c-row.hdr span { font-family: 'EB Garamond', serif; font-size: 0.74rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-light); }
  .c-row.me  { background: rgba(201,168,76,0.06); border-left: 3px solid var(--gold); }
  .c-rank    { font-family: 'Playfair Display', serif; font-size: 1.1rem; color: var(--gold); font-weight: 700; display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
  .c-user    { font-family: 'Playfair Display', serif; font-size: 1rem; color: var(--text-dark); }
  .c-user small { display: block; font-family: 'Crimson Text', serif; font-weight: normal; font-size: 0.78rem; color: var(--text-light); margin-top: 2px; line-height: 1.4; }
  .c-score   { font-family: 'Playfair Display', serif; font-size: 1.2rem; font-weight: 700; }

  /* Misc */
  .back-btn       { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; cursor: pointer; font-family: 'EB Garamond', serif; font-size: 0.84rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-light); margin-bottom: 1.5rem; padding: 0; transition: color 0.15s; }
  .back-btn:hover { color: var(--green-dark); }
  .loading        { text-align: center; padding: 3rem; color: var(--text-light); font-family: 'EB Garamond', serif; letter-spacing: 0.08em; }
  .empty          { text-align: center; padding: 3rem 2rem; color: var(--text-light); font-family: 'Crimson Text', serif; font-style: italic; line-height: 1.6; }
  .info-banner    { background: var(--gold-pale); border: 1px solid #d4b96a; border-radius: 3px; padding: 0.8rem 1.2rem; font-family: 'Crimson Text', serif; color: #7a5a10; font-size: 0.92rem; margin-bottom: 1.5rem; }
  .search-wrap    { padding: 0.8rem 1.4rem; border-bottom: 1px solid var(--cream-dark); }
  .search-input   { width: 100%; padding: 0.56rem 0.9rem; border: 1px solid var(--cream-dark); border-radius: 2px; font-family: 'Crimson Text', serif; font-size: 0.94rem; color: var(--text-dark); background: var(--cream); outline: none; transition: border-color 0.2s; }
  .search-input:focus { border-color: var(--green-mid); background: var(--white); }
  .inline-tag { display: inline-block; font-family: 'EB Garamond', serif; font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 1px 6px; border-radius: 2px; vertical-align: middle; margin-left: 6px; }

  /* Sortable table headers */
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--gold); }
  th.sortable .sort-icon { display: inline-block; margin-left: 4px; opacity: 0.35; font-size: 0.7em; }
  th.sortable.sort-active .sort-icon { opacity: 1; color: var(--gold); }

  /* Page fade transition */
  @keyframes pageFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .page-fade { animation: pageFadeIn 0.2s ease-out; }

  /* Tooltips */
  .tip-wrap { display: inline-flex; align-items: center; vertical-align: middle; }
  .tip-icon { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; background: rgba(201,168,76,0.15); border: 1px solid rgba(201,168,76,0.4); color: var(--gold); font-family: 'EB Garamond', serif; font-size: 0.7rem; cursor: pointer; margin-left: 5px; flex-shrink: 0; line-height: 1; user-select: none; }
  .tip-box { position: fixed; background: #1e3a1e; border: 1px solid rgba(201,168,76,0.35); border-radius: 3px; padding: 10px 14px; font-family: 'Crimson Text', serif; font-size: 0.92rem; color: var(--cream); white-space: normal; z-index: 9999; line-height: 1.55; font-weight: normal; text-transform: none; letter-spacing: normal; box-shadow: 0 6px 24px rgba(0,0,0,0.45); pointer-events: none; }
  .tip-arrow { position: absolute; top: 100%; width: 0; height: 0; border: 6px solid transparent; border-top-color: rgba(201,168,76,0.4); transform: translateX(-50%); pointer-events: none; }
  @media (max-width: 640px) {
    .tip-icon { width: 18px; height: 18px; font-size: 0.75rem; }
    .tip-box { font-size: 0.95rem; }
  }

  /* Pick progress indicator */
  .pick-progress { display: flex; align-items: center; gap: 0; margin-bottom: 1.2rem; font-family: 'EB Garamond', serif; font-size: 0.8rem; }
  .pick-step { display: flex; align-items: center; gap: 6px; padding: 0.45rem 0.9rem; border: 1px solid var(--cream-dark); background: var(--cream); color: var(--text-light); flex: 1; justify-content: center; }
  .pick-step:first-child { border-radius: 3px 0 0 3px; }
  .pick-step:last-child  { border-radius: 0 3px 3px 0; }
  .pick-step.done   { background: #1a3a1a; border-color: #4a8a4a; color: #90d090; }
  .pick-step.active { background: var(--gold-pale); border-color: #d4b96a; color: #5a3e08; font-weight: 600; }
  .pick-step .step-num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; font-size: 0.7rem; font-weight: 700; background: currentColor; flex-shrink: 0; }
  .pick-step .step-num span { color: var(--cream); }
  .pick-step.done .step-num { background: #4a8a4a; }
  .pick-step.done .step-num span { color: #e0f0e0; }
  @media (max-width: 480px) {
    .pick-progress { font-size: 0.72rem; }
    .pick-step { padding: 0.4rem 0.5rem; }
  }

  /* First-pick nudge */
  @keyframes nudgeBounce {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(4px); }
  }
  .first-pick-nudge { display: flex; align-items: center; gap: 10px; padding: 0.65rem 1.2rem; margin-bottom: 0.6rem; background: #1a2a1a; border: 1px dashed #4a7a4a; border-radius: 3px; font-family: 'EB Garamond', serif; font-size: 0.9rem; color: #90d090; }
  .first-pick-nudge .nudge-arrow { font-size: 1.2rem; animation: nudgeBounce 1.2s ease-in-out infinite; }

  /* Save confirmation animation */
  @keyframes saveConfirm {
    0%   { box-shadow: 0 0 0 0 rgba(80,200,80,0.6), 0 0 0 0 rgba(80,200,80,0.3); background: rgba(60,160,60,0.10); }
    40%  { box-shadow: 0 0 0 6px rgba(80,200,80,0.2), 0 0 0 14px rgba(80,200,80,0.05); background: rgba(60,160,60,0.18); }
    100% { box-shadow: 0 0 0 0 rgba(80,200,80,0), 0 0 0 0 rgba(80,200,80,0); background: transparent; }
  }
  .team-card.save-confirmed { animation: saveConfirm 1.4s ease-out; }

  @keyframes checkPop {
    0%   { transform: scale(0) rotate(-20deg); opacity: 0; }
    55%  { transform: scale(1.25) rotate(6deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  .save-check-overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 10;
    background: rgba(26,46,26,0.82); border-radius: 4px; pointer-events: none;
    animation: checkPop 0.45s cubic-bezier(0.34,1.56,0.64,1) both;
  }
  .save-check-icon {
    width: 56px; height: 56px; border-radius: 50%;
    background: rgba(80,200,80,0.18); border: 2px solid #60c060;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.8rem; color: #80e880; margin-bottom: 10px;
  }
  .save-check-label {
    font-family: 'EB Garamond', serif; font-size: 0.95rem; letter-spacing: 0.1em;
    text-transform: uppercase; color: #a0e8a0;
  }

  /* Unsaved changes indicator */
  @keyframes unsavedPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(201,168,76,0.5); }
    50%       { box-shadow: 0 0 0 5px rgba(201,168,76,0); }
  }
  .btn-save.has-changes { animation: unsavedPulse 2s ease-in-out infinite; border: 1px solid rgba(201,168,76,0.6); }
  .picks-status-bar {
    padding: 0.5rem 1.4rem; border-top: 1px solid rgba(255,255,255,0.06);
    font-family: 'EB Garamond', serif; font-size: 0.8rem; letter-spacing: 0.04em;
    display: flex; align-items: center; gap: 6px;
  }
  .picks-status-bar.incomplete { color: #c08040; }
  .picks-status-bar.unsaved    { color: #d4b96a; }
  .picks-status-bar.saved      { color: #70c070; }
  /* ── Mobile overrides (must be last to win cascade over base styles above) ── */
  @media (max-width: 640px) {
    .btn-full      { display: none; }
    .btn-icon      { display: inline; }
    .pick-btn      { padding: 2px 6px; font-size: 0.7rem; }
    .team-head     { padding: 0.6rem 1rem; }
    .team-body     { padding: 0.3rem 1rem; }
    .team-total    { padding: 0.6rem 1rem; }
    .team-tier-sum { padding: 0.35rem 1rem; }
    .team-save     { padding: 0.5rem 1rem; }
    .t-slot        { min-height: 34px; }
  }
`;

// ─── Tooltip component ────────────────────────────────────────────────────────
// Tracks which tip is currently open so we can enforce one-at-a-time
let activeTipRef = null;

function Tip({ text }) {
  const [open, setOpen] = useState(false);
  const [boxStyle, setBoxStyle] = useState({});
  const [arrowLeft, setArrowLeft] = useState("50%");
  const iconRef = useRef(null);
  // Stable identity for this instance — used to compare against activeTipRef
  const selfRef = useRef(null);
  selfRef.current = selfRef.current || {};
  // Always keep close function fresh so activeTipRef can call it
  selfRef.current.close = () => setOpen(false);

  useEffect(() => () => { if (activeTipRef === selfRef) activeTipRef = null; }, []);

  const calcPosition = () => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    const tipW = window.innerWidth <= 640 ? Math.min(300, window.innerWidth - 24) : 380;
    const iconCx = rect.left + rect.width / 2;
    let left = iconCx - tipW / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tipW - 12));
    setArrowLeft(`${iconCx - left}px`);
    setBoxStyle({ top: rect.top - 10, left, width: tipW, transform: "translateY(-100%)" });
  };

  const openTip = () => {
    if (activeTipRef && activeTipRef !== selfRef) activeTipRef.current.close();
    activeTipRef = selfRef;
    calcPosition();
    setOpen(true);
  };

  const closeTip = () => {
    setOpen(false);
    if (activeTipRef === selfRef) activeTipRef = null;
  };

  const isMobile = () => window.matchMedia("(pointer: coarse)").matches;

  // Mobile: close when tapping anywhere outside the icon
  useEffect(() => {
    if (!open || !isMobile()) return;
    const onOutside = e => {
      if (iconRef.current && !iconRef.current.contains(e.target)) closeTip();
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [open]);

  return (
    <span
      className="tip-wrap"
      onClick={e => { e.stopPropagation(); if (!isMobile()) return; open ? closeTip() : openTip(); }}
      onMouseEnter={() => { if (!isMobile()) openTip(); }}
      onMouseLeave={() => { if (!isMobile()) closeTip(); }}
    >
      <span className="tip-icon" ref={iconRef}>?</span>
      {open && <span className="tip-box" style={boxStyle}>{text}<span className="tip-arrow" style={{left: arrowLeft}} /></span>}
    </span>
  );
}

// ─── Update Banner ───────────────────────────────────────────────────────────
const BUILD_ID = import.meta.env.VITE_BUILD_ID;

function UpdateBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!BUILD_ID || BUILD_ID === "dev") return;

    const check = async () => {
      try {
        const res = await fetch(`/api/version?_=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.version && data.version !== BUILD_ID) setVisible(true);
      } catch {}
    };

    check();
    const id = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 101, width: "100%",
      background: "linear-gradient(90deg, #1d4ed8, #4f46e5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: "12px", padding: "8px 16px",
    }}>
      <span style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>
        A new version is available
      </span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: "rgba(255,255,255,0.2)",
          border: "1px solid rgba(255,255,255,0.4)",
          borderRadius: 6, color: "#fff",
          fontSize: 12, fontWeight: 700,
          padding: "4px 12px", cursor: "pointer",
        }}
      >
        Update now
      </button>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]               = useState(null);
  const [booting, setBooting]         = useState(true);
  const [page, setPage]               = useState("tournaments");
  const [activeTournament, setActiveTournament] = useState(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState(null);
  const [navPhotoError, setNavPhotoError]     = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // Listen to Firebase Auth state — fires on page load and on login/logout
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        // Log once per browser session to avoid a log entry on every page refresh
        const sessionKey = `gf_session_${firebaseUser.uid}`;
        if (!sessionStorage.getItem(sessionKey)) {
          sessionStorage.setItem(sessionKey, "1");
          logActivity(firebaseUser.uid, firebaseUser.email, "login", {
            method: firebaseUser.providerData?.[0]?.providerId || "unknown",
            displayName: firebaseUser.displayName || null,
          });
          if (firebaseUser.email) {
            store.get("player_emails").then(emails => {
              store.set("player_emails", { ...(emails || {}), [firebaseUser.uid]: firebaseUser.email });
            });
          }
        }
      }
      setUser(firebaseUser || null);
      setProfilePhotoUrl(firebaseUser?.photoURL || null);
      setNavPhotoError(false);
      setBooting(false);
    });
    return unsub; // cleanup listener when component unmounts
  }, []);

  const logout = () => {
    signOut(auth);
    setPage("tournaments");
    setActiveTournament(null);
  };

  const isAdmin = user?.email === ADMIN_EMAIL;

  if (booting) return (
    <div className="auth-wrap">
      <style>{CSS}</style>
      <div className="loading">Loading…</div>
    </div>
  );

  if (!user) return <AuthPage />;

  return (
    <div className="app">
      <style>{CSS}</style>
      <UpdateBanner />
      <header className="header">
        <div onClick={() => setPage("tournaments")} style={{cursor:"pointer"}}>
          <div className="header-logo">RC Golf Sweeps</div>
        </div>
        <nav className="header-nav">
          <button className={`nav-btn ${page==="tournaments"?"active":""}`} onClick={() => setPage("tournaments")}>Tournaments</button>
          <button className={`nav-btn ${page==="competition"?"active":""}`} onClick={() => setPage("competition")}>Leaderboard</button>
          <button className={`nav-btn ${page==="myresults"?"active":""}`} onClick={() => setPage("myresults")}>My Results</button>
          {isAdmin && <button className={`nav-btn ${page==="dashboard"?"active":""}`} onClick={() => setPage("dashboard")}>Admin</button>}
          {isAdmin && <span className="admin-badge">Admin</span>}
          <button className={`nav-btn nav-user ${page==="profile"?"active":""}`} onClick={() => setPage("profile")}
            style={{display:"flex", alignItems:"center", gap:"6px", padding:"4px 8px"}}>
            {profilePhotoUrl && !navPhotoError
              ? <img src={profilePhotoUrl} alt="" onError={() => setNavPhotoError(true)} style={{width:"22px", height:"22px", borderRadius:"50%", objectFit:"cover", border:"1px solid var(--gold)"}} />
              : <span style={{width:"22px", height:"22px", borderRadius:"50%", background:"var(--green-mid)", border:"1px solid var(--gold)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:"0.7rem", color:"var(--cream)", fontWeight:700}}>
                  {(user.displayName || user.email || "?")[0].toUpperCase()}
                </span>
            }
            <span style={{color:"var(--gold)", fontSize:"0.78rem"}}>{user.displayName || user.email}</span>
          </button>
          <button className="nav-btn logout" onClick={logout}>Sign Out</button>
        </nav>
      </header>
      <main className="main">
        <div key={page} className="page-fade">
          {page === "tournaments" && (
            <TournamentsPage isAdmin={isAdmin} onSelect={t => { setActiveTournament(t); setPage("tournament"); }} />
          )}
          {page === "tournament" && activeTournament && (
            <TournamentPage user={user} isAdmin={isAdmin} tournament={activeTournament} onBack={() => setPage("tournaments")} />
          )}
          {page === "competition" && (
            <CompetitionPage user={user} isAdmin={isAdmin} />
          )}
          {page === "myresults" && (
            <MyResultsPage user={user} />
          )}
          {page === "dashboard" && isAdmin && (
            <ParticipantDashboard />
          )}
          {page === "profile" && (
            <ProfilePage user={user} onPhotoSaved={url => setProfilePhotoUrl(url)} />
          )}
        </div>
      </main>
      <footer className="app-footer">
        RC Golf Sweeps · Private competition ·{" "}
        <a onClick={() => setShowPrivacy(true)}>Privacy notice</a>
      </footer>
      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
    </div>
  );
}

// ─── Privacy Modal ────────────────────────────────────────────────────────────
function PrivacyModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Privacy Notice</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p>RC Golf Sweeps is a private fantasy golf competition for invited participants. This notice explains what personal data we hold and why.</p>

          <h3>What we collect</h3>
          <ul>
            <li><strong>Email address and name</strong> — provided when you register, used to identify your account and send pick reminder emails</li>
            <li><strong>Your picks</strong> — the 5 golfers you select for each tournament</li>
            <li><strong>Usage activity</strong> — a log of when you view tournaments and save picks, used by the organiser to manage the competition</li>
          </ul>

          <h3>How it's used</h3>
          <p>Your data is used solely to run the RC Golf Sweeps competition. Picks are shared with other participants after the organiser reveals entries for each tournament. Your email address is never shared with other participants.</p>

          <h3>Where it's stored</h3>
          <p>Data is stored securely in Google Firebase (Firestore and Authentication), hosted in the EU/US by Google. Reminder emails are sent via Resend. No data is sold or shared with third parties beyond these infrastructure providers.</p>

          <h3>Your rights</h3>
          <p>Under UK/EU GDPR you have the right to access, correct, or request deletion of your data at any time. To exercise any of these rights, contact the organiser at <strong>rosscoy95@gmail.com</strong> and your account and all associated data will be removed within 30 days.</p>

          <h3>Retention</h3>
          <p>Data is retained for the duration of the competition season and deleted on request. Accounts that have been inactive for over 2 years may be removed.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Auth Page ────────────────────────────────────────────────────────────────
function AuthPage() {
  const [tab, setTab]   = useState("login");
  const [form, setForm] = useState({ email:"", password:"", name:"", mobile:"" });
  const [error, setError]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showReset, setShowReset]   = useState(false);
  const [resetSent, setResetSent]   = useState(false);

  const signInWithGoogle = async () => {
    setError(""); setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (e) {
      setError("Google sign-in failed. Please try again.");
    }
    setLoading(false);
  };

  const submit = async () => {
    setError(""); setLoading(true);
    try {
      if (!form.email || !form.password) throw new Error("Please fill in all fields.");

      // Rate limit: 5 attempts per 15 minutes per email
      const rl = checkAuthRateLimit(form.email);
      if (!rl.allowed) {
        setError(`Too many attempts. Please try again in ${rl.minutesLeft} minute${rl.minutesLeft !== 1 ? "s" : ""}.`);
        setLoading(false);
        return;
      }

      if (tab === "login") {
        await signInWithEmailAndPassword(auth, form.email, form.password);
        clearAuthRateLimit(form.email); // successful login resets the counter
      } else {
        const nameErr = validateName(form.name);
        if (nameErr) throw new Error(nameErr);
        const mobileErr = validateMobile(form.mobile);
        if (mobileErr) throw new Error(mobileErr);
        const cleanName   = sanitizeText(form.name, 100);
        const cleanMobile = sanitizeText(form.mobile, 20);
        const cred = await createUserWithEmailAndPassword(auth, form.email, form.password);
        clearAuthRateLimit(form.email);
        await updateProfile(cred.user, { displayName: cleanName });
        // Store mobile number
        const existingMobiles = await store.get("player_mobile").then(v => v || {});
        await store.set("player_mobile", { ...existingMobiles, [cred.user.uid]: cleanMobile });
      }
    } catch (e) {
      recordAuthFailure(form.email);
      const msg = {
        "auth/user-not-found":       "No account found with this email.",
        "auth/wrong-password":       "Incorrect password.",
        "auth/email-already-in-use": "An account with this email already exists.",
        "auth/weak-password":        "Password must be at least 6 characters.",
        "auth/invalid-email":        "Please enter a valid email address.",
        "auth/invalid-credential":   "Incorrect email or password.",
      }[e.code] || e.message;
      setError(msg);
      if (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential") {
        setShowReset(true);
      }
    }
    setLoading(false);
  };

  const sendReset = async () => {
    if (!form.email) { setError("Please enter your email address first."); return; }

    // Rate limit password reset requests too
    const rl = checkAuthRateLimit(form.email);
    if (!rl.allowed) {
      setError(`Too many attempts. Please try again in ${rl.minutesLeft} minute${rl.minutesLeft !== 1 ? "s" : ""}.`);
      return;
    }

    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, form.email);
      setResetSent(true);
      setShowReset(false);
      setError("");
    } catch (e) {
      recordAuthFailure(form.email);
      setError(e.code === "auth/user-not-found" ? "No account found with this email." : "Could not send reset email. Please try again.");
    }
    setLoading(false);
  };

  return (
    <div className="auth-wrap">
      <style>{CSS}</style>
      <div className="auth-bg" />
      <div className="auth-card">
        <div className="auth-title">RC Golf Sweeps</div>
        <div className="auth-subtitle">Golf Competition Tracker</div>

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          style={{
            width:"100%", padding:"0.75rem", marginBottom:"1.2rem",
            background:"var(--white)", color:"var(--text-dark)",
            border:"1px solid var(--cream-dark)", borderRadius:"2px",
            cursor:"pointer", fontFamily:"'EB Garamond', serif",
            fontSize:"0.95rem", letterSpacing:"0.04em",
            display:"flex", alignItems:"center", justifyContent:"center", gap:"10px",
            transition:"background 0.2s",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          {loading ? "Please wait…" : "Continue with Google"}
        </button>

        <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"1.2rem"}}>
          <div style={{flex:1, height:"1px", background:"var(--cream-dark)"}}></div>
          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"var(--text-light)", letterSpacing:"0.06em"}}>or</span>
          <div style={{flex:1, height:"1px", background:"var(--cream-dark)"}}></div>
        </div>

        <div className="auth-tabs">
          <div className={`auth-tab ${tab==="login"?"active":""}`}    onClick={() => { setTab("login");    setError(""); setShowReset(false); setResetSent(false); }}>Sign In</div>
          <div className={`auth-tab ${tab==="register"?"active":""}`} onClick={() => { setTab("register"); setError(""); setShowReset(false); setResetSent(false); }}>Register</div>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {resetSent && (
          <div style={{background:"#edf7ed", border:"1px solid #a5d6a7", borderRadius:"3px", padding:"0.65rem 0.9rem", marginBottom:"0.8rem", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", color:"#2e7d32"}}>
            Password reset email sent. Check your inbox.
          </div>
        )}
        {showReset && !resetSent && (
          <div style={{background:"var(--cream)", border:"1px solid var(--cream-dark)", borderRadius:"3px", padding:"0.65rem 0.9rem", marginBottom:"0.8rem", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", color:"var(--text-mid)", display:"flex", alignItems:"center", justifyContent:"space-between", gap:"0.75rem"}}>
            <span>Forgotten your password?</span>
            <button className="btn-sm" onClick={sendReset} disabled={loading}>Send reset email</button>
          </div>
        )}
        {tab === "register" && (
          <div className="field">
            <label>Full Name</label>
            <input value={form.name} onChange={e => setForm(f=>({...f, name:e.target.value}))} placeholder="Your name" />
          </div>
        )}
        {tab === "register" && (
          <div className="field">
            <label>Mobile Number</label>
            <input type="tel" value={form.mobile} onChange={e => setForm(f=>({...f, mobile:e.target.value}))} placeholder="+353 87 123 4567" />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input type="email" value={form.email} onChange={e => setForm(f=>({...f, email:e.target.value}))} placeholder="you@example.com" onKeyDown={e=>e.key==="Enter"&&submit()} />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={form.password} onChange={e => setForm(f=>({...f, password:e.target.value}))} placeholder="········" onKeyDown={e=>e.key==="Enter"&&submit()} />
        </div>
        <button className="btn-primary" onClick={submit} disabled={loading}>
          {loading ? "Please wait…" : tab==="login" ? "Sign In" : "Create Account"}
        </button>

        {tab === "register" && (
          <div className="auth-privacy">
            By creating an account you agree that your name, email address, and picks
            will be stored and used to run the competition.{" "}
            <a onClick={() => setShowPrivacy(true)}>Privacy notice</a>
          </div>
        )}

        {tab === "login" && (
          <div className="auth-privacy">
            <a onClick={() => setShowPrivacy(true)}>Privacy notice</a>
          </div>
        )}
      </div>
      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
    </div>
  );
}

// ─── Tournaments Page ─────────────────────────────────────────────────────────
function TournamentsPage({ onSelect, isAdmin }) {
  const [events, setEvents]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = useCallback(async () => {
    const evs = await fetchTournaments();
    const sorted = [...evs].sort((a,b) => new Date(a.date) - new Date(b.date));
    setEvents(sorted);
  }, []);

  useEffect(() => {
    loadEvents().then(() => setLoading(false));
  }, [loadEvents]);

  const refresh = async () => { setRefreshing(true); await loadEvents(); setRefreshing(false); };

  // Majors only
  const shown = events.filter(e => isMajor(e.name));

  const now = Date.now();
  const nextId = shown.find(e => {
    const start  = e.date    ? new Date(e.date).getTime()    : null;
    const end    = e.endDate ? new Date(e.endDate).getTime() : null;
    const endEOD = end ? end + 24*60*60*1000 : null;
    return start && start > now && !(endEOD && now > endEOD);
  })?.id ?? null;

  return (
    <div>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:"0.5rem", marginBottom:"0.25rem"}}>
        <div className="page-title" style={{marginBottom:0}}>Tournaments</div>
        <button className="pick-btn" onClick={refresh} disabled={refreshing || loading}>
          {refreshing ? "↻…" : "↻ Refresh"}
        </button>
      </div>
      <div className="page-subtitle">Select a tournament to view the leaderboard and pick your team</div>
      {loading
        ? <div className="loading">Fetching tournaments from ESPN…</div>
        : shown.length === 0
          ? <div className="empty">No tournaments found.</div>
          : <div className="tournaments-grid">{shown.map(ev => <TCard key={ev.id} event={ev} isNext={ev.id === nextId} onClick={() => onSelect(ev)} />)}</div>
      }
    </div>
  );
}

function TCard({ event, onClick, isNext }) {
  const major = isMajor(event.name);
  // Derive status from dates since calendar entries don't carry a live/post flag
  const now     = Date.now();
  const start   = event.date    ? new Date(event.date).getTime()    : null;
  const end     = event.endDate ? new Date(event.endDate).getTime() : null;
  // Add 1 day buffer to end so "completed" only shows after the day is fully done
  const endEOD  = end ? end + 24*60*60*1000 : null;
  const statusLabel = (!start || !endEOD)
    ? "upcoming"
    : now >= start && now <= endEOD
      ? "live"
      : now > endEOD
        ? "completed"
        : "upcoming";
  const dateStr = event.date
    ? new Date(event.date).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})
    : "-";
  return (
    <div className={`t-card ${major?"major":""} ${isNext?"next":""}`} onClick={onClick}>
      <div className="t-head">
        {major && <div className="t-badge">Major</div>}
        <div className="t-name">{event.name||event.shortName}</div>
      </div>
      <div className="t-body">
        <div className="t-meta">
          <div className="t-meta-item"><strong>{dateStr}</strong>Date</div>
        </div>
        <div style={{display:"flex", gap:"6px", alignItems:"center", flexWrap:"wrap"}}>
          {isNext && <span className="pill next-up">▶ Next Up</span>}
          <span className={`pill ${statusLabel}`}>{statusLabel==="live"?"Live":statusLabel==="completed"?"Completed":"Upcoming"}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Tournament Page ──────────────────────────────────────────────────────────
function TournamentPage({ user, isAdmin, tournament, onBack }) {
  const [players, setPlayers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [picks, setPicks]       = useState([]);
  const [savedPickIds, setSavedPickIds] = useState([]); // IDs last confirmed saved to Firestore
  const [saveSuccess, setSaveSuccess]   = useState(false); // triggers confirmation animation
  const [search, setSearch]     = useState("");
  const [saveMsg, setSaveMsg]   = useState("");
  const [locked, setLocked]     = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [espnCut, setEspnCut]   = useState(null);
  const [cutScore, setCutScore] = useState(null);
  const [cutInput, setCutInput] = useState("");
  const [cutOverrideActive, setCutOverrideActive] = useState(false);
  const [cutAudit, setCutAudit] = useState(null); // {setBy, setAt, source}
  const [tierOverrides, setTierOverrides] = useState({}); // {playerId: tier}
  const [view, setView]         = useState("picks"); // "picks" | "entries" | "tiers"
  const [allEntries, setAllEntries] = useState([]);
  const [rankings, setRankings] = useState([]); // world rankings [{id, name, rank}]
  const [now, setNow]           = useState(Date.now()); // ticks every second for countdown
  const [autoLockTime, setAutoLockTime] = useState(null); // ISO string for scheduled auto-lock
  const [autoLockInput, setAutoLockInput] = useState(""); // datetime-local input value
  const [firstTeeTime, setFirstTeeTime] = useState(null); // ISO string of first tee time from ESPN
  const [adminOpen, setAdminOpen] = useState(false);
  const [sortCol, setSortCol]   = useState("pos");
  const [sortDir, setSortDir]   = useState("asc");
  const autoRefreshRef          = useRef(null);
  const teamCardRef             = useRef(null);
  const [rankingsRefreshing, setRankingsRefreshing] = useState(false);
  const [rankingsMsg, setRankingsMsg]               = useState("");
  const [tournamentOdds, setTournamentOdds]         = useState({}); // normName → odds position
  const [oddsFetching, setOddsFetching]             = useState(false);
  const [oddsMsg, setOddsMsg]                       = useState("");
  const [nationalityMap, setNationalityMap]         = useState({});
  const [prizePositions, setPrizePositions]         = useState(null); // null = auto from entry count
  const [potOverride, setPotOverride]               = useState(null); // null = auto (entries × fee)
  const [potInput, setPotInput]                     = useState("");   // controlled input for pot override
  const [paidMap, setPaidMap]                       = useState({});   // { [uid]: boolean } per tournament
  const [summaryRevealed, setSummaryRevealed]       = useState(false);
  const [prizeRevealed, setPrizeRevealed]           = useState(false);
  const [playerNames, setPlayerNames]               = useState({});   // admin-set name overrides

  // Firestore document keys — all namespaced under golfFantasy collection
  const picksKey        = `picks__${user.uid}__${tournament.id}`;
  const allPicksKey     = `allpicks__${tournament.id}`;
  const lockKey         = `lock__${tournament.id}`;
  const revealKey       = `reveal__${tournament.id}`;
  const cutKey          = `cut__${tournament.id}`;
  const autoLockKey     = `autolock__${tournament.id}`;
  const tierKey         = `tiers__${tournament.id}`;
  const oddsKey         = `odds__${tournament.id}`;
  const paidKey         = `paid__${tournament.id}`;
  const summaryRevealKey = `summaryrevealed__${tournament.id}`;
  const prizeRevealKey  = `prizerevealed__${tournament.id}`;
  const prizePositionsKey = `prizepositions__${tournament.id}`;

  const loadData = useCallback(async () => {
    const [{ players: p, espnCutScore, firstTeeTime: ftt }, savedCut] = await Promise.all([
      fetchLeaderboard(tournament.id, tournament.date),
      store.get(cutKey),
    ]);
    setPlayers(p);
    setEspnCut(espnCutScore);
    if (ftt) setFirstTeeTime(ftt);
    if (savedCut !== null && savedCut !== undefined) {
      const v = savedCut.value ?? savedCut;
      setCutScore(v);
      setCutOverrideActive(savedCut.setBy ? true : false); // manual overrides show as active; auto-saved ESPN cuts do not
      setCutInput(String(v));
      setCutAudit(savedCut.setBy ? savedCut : null);
    } else if (savedCut === null && espnCutScore !== null && espnCutScore !== undefined) {
      // Doc confirmed absent — auto-persist ESPN cut so it survives after the tournament ends and ESPN stops returning it
      await store.set(cutKey, { value: espnCutScore, source: "espn_auto", setAt: Date.now() });
      setCutScore(espnCutScore);
      setCutOverrideActive(false);
      setCutAudit(null);
    } else {
      // savedCut is undefined (Firestore read error) or no cut available at all
      // Show ESPN cut for display if present, but never write to Firestore to avoid overwriting a manual override
      setCutScore(espnCutScore ?? null);
      setCutOverrideActive(false);
      setCutAudit(null);
    }
    setLoading(false);
  }, [tournament.id, cutKey]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [firestorePicks, lockState, revealState, allPicksRaw, autoLock, tierData, natData, oddsData, paidData, summaryRevealData, prizeRevealData, prizePositionsData, savedPlayerNames] = await Promise.all([
        store.get(picksKey),
        store.get(lockKey),
        store.get(revealKey),
        store.get(`allpicks__${tournament.id}`),
        store.get(`autolock__${tournament.id}`),
        store.get(`tiers__${tournament.id}`),
        store.get("player_nationality"),
        store.get(`odds__${tournament.id}`),
        store.get(paidKey),
        store.get(summaryRevealKey),
        store.get(prizeRevealKey),
        store.get(prizePositionsKey),
        store.get("player_names"),
      ]);
      if (natData) setNationalityMap(natData);
      // Fall back to localStorage if Firestore didn't return picks (e.g. permission error)
      const savedPicks = firestorePicks ?? (() => {
        try { return JSON.parse(localStorage.getItem(`gf_${picksKey}`)); } catch { return null; }
      })();
      if (savedPicks) {
        setPicks(savedPicks);
        setSavedPickIds(savedPicks.map(p => p.id));
      }
      // Log tournament page view (once per page load)
      logActivity(user.uid, user.email, "tournament_viewed", {
        tournamentId: tournament.id,
        tournamentName: tournament.name,
      });
      setLocked(!!lockState?.locked);
      setRevealed(!!revealState?.revealed);
      if (allPicksRaw) setAllEntries(Object.values(allPicksRaw));
      if (autoLock?.time) { setAutoLockTime(autoLock.time); setAutoLockInput(autoLock.time.slice(0,16)); }
      if (tierData) setTierOverrides(tierData);
      if (oddsData?.positions) {
        setTournamentOdds(oddsData.positions);
        setOddsMsg(`✓ Odds loaded (${Object.keys(oddsData.positions).length} players · ${oddsData.eventName || "cached"})`);
      }
      if (paidData) setPaidMap(paidData);
      if (summaryRevealData?.revealed) setSummaryRevealed(true);
      if (prizeRevealData?.revealed) setPrizeRevealed(true);
      if (prizePositionsData?.positions) setPrizePositions(prizePositionsData.positions);
      if (savedPlayerNames) setPlayerNames(savedPlayerNames);
      // Load rankings: prefer Firestore (kept fresh by admin refresh), fall back to static
      const storedRankings = await store.get("worldRankings");
      if (storedRankings?.rankings && Object.keys(storedRankings.rankings).length > 0) {
        setRankings(Object.entries(storedRankings.rankings).map(([id, rank]) => ({ id, name: "", rank })));
      } else {
        setRankings(fetchWorldRankings());
      }
      await loadData();
    })();
  }, [loadData, picksKey, lockKey, revealKey]);

  const refresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  // Tick clock every second for countdown timer + auto-lock check
  useEffect(() => {
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      // Auto-lock: if scheduled lock time has passed and not yet locked
      setAutoLockTime(alt => {
        if (alt && !locked && new Date(alt).getTime() <= n) {
          store.set(`lock__${tournament.id}`, { locked: true, by: "auto", at: n });
          setLocked(true);
        }
        return alt;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [locked, tournament.id]);

  // Auto-refresh leaderboard every 2 minutes when tournament is live
  useEffect(() => {
    const isLive = (() => {
      const start  = new Date(tournament.date).getTime();
      const end    = tournament.endDate ? new Date(tournament.endDate).getTime() + 24*60*60*1000
                                        : start + 4*24*60*60*1000;
      const n = Date.now();
      return n >= start && n <= end;
    })();
    if (!isLive) return;
    autoRefreshRef.current = setInterval(() => {
      loadData();
    }, 2 * 60 * 1000); // every 2 minutes
    return () => clearInterval(autoRefreshRef.current);
  }, [loadData, tournament.date, tournament.endDate]);

  const toggleLock = async () => {
    const next = !locked;
    await store.set(lockKey, { locked: next, by: user.email, at: Date.now() });
    setLocked(next);
  };

  const toggleReveal = async () => {
    const next = !revealed;
    await store.set(revealKey, { revealed: next, by: user.email, at: Date.now() });
    setRevealed(next);
  };

  const applyCutOverride = async () => {
    const err = validateCutScore(cutInput);
    if (err) { setCutAudit(null); setCutInput(""); return; } // silently reject malformed input
    const val = parseInt(cutInput.trim().replace("+",""), 10);
    const record = { value: val, setBy: user.email, setAt: Date.now(), source: "manual" };
    await store.set(cutKey, record);
    setCutScore(val); setCutOverrideActive(true);
    setCutAudit(record);
  };

  const clearCutOverride = async () => {
    await store.del(cutKey);
    setCutScore(espnCut); setCutOverrideActive(false); setCutInput("");
  };

  const togglePick = (player) => {
    if (locked) return;
    setSaveMsg("");
    setPicks(prev =>
      prev.find(p => p.id===player.id)
        ? prev.filter(p => p.id!==player.id)
        : prev.length < MAX_PICKS ? [...prev, {id:player.id, name:player.name}] : prev
    );
  };

  // Countdown helper — returns string like "2h 14m 33s" or null if past
  const lockCountdown = useMemo(() => {
    if (!autoLockTime) return null;
    const diff = new Date(autoLockTime).getTime() - now;
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }, [autoLockTime, now]);

  // Milliseconds until lock — used for countdown colour urgency
  const lockCountdownMs = useMemo(() => {
    if (!autoLockTime) return null;
    const diff = new Date(autoLockTime).getTime() - now;
    return diff > 0 ? diff : null;
  }, [autoLockTime, now]);

  const refreshWorldRankings = async () => {
    setRankingsRefreshing(true);
    setRankingsMsg("");
    try {
      const res = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/golf/pga/rankings?limit=200"
      );
      if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
      const data = await res.json();

      // Handle multiple possible ESPN response shapes
      const map = {};
      if (Array.isArray(data.athletes)) {
        data.athletes.forEach(a => { if (a.id && a.rank) map[String(a.id)] = Number(a.rank); });
      } else if (Array.isArray(data.rankings)) {
        data.rankings.forEach(r => { if (r.athlete?.id && r.rank) map[String(r.athlete.id)] = Number(r.rank); });
      } else if (Array.isArray(data.items)) {
        // Core API format: items have rank, athlete ref needs extracting
        data.items.forEach((item, i) => {
          const idMatch = item?.athlete?.$ref?.match(/athletes\/(\d+)/);
          if (idMatch) map[idMatch[1]] = item.rank ?? (i + 1);
        });
      }

      if (Object.keys(map).length === 0) {
        throw new Error("No rankings found in ESPN response — the API format may have changed");
      }

      await store.set("worldRankings", { rankings: map, updatedAt: Date.now() });
      setRankings(Object.entries(map).map(([id, rank]) => ({ id, name: "", rank })));
      setRankingsMsg(`✓ Updated ${Object.keys(map).length} player rankings`);
    } catch (e) {
      setRankingsMsg(`⚠ ${e.message}`);
    } finally {
      setRankingsRefreshing(false);
    }
  };

  const fetchTournamentOdds = async () => {
    setOddsFetching(true);
    setOddsMsg("");
    try {
      // Fetch all active golf sports via our server-side proxy (avoids CORS)
      const sportsRes = await fetch(`/api/odds`);
      if (!sportsRes.ok) throw new Error(`Odds API returned ${sportsRes.status}`);
      const allSports = await sportsRes.json();

      const golfSports = allSports
        .filter(s => s.group === "Golf" && s.active)
        .map(s => s.key);

      if (golfSports.length === 0) throw new Error("No active golf markets found in The Odds API");

      const tournWords = tournament.name.toLowerCase().split(/\s+/);
      let bestEvent = null;
      let bestSport = null;

      // Try each sport key; prefer events whose title shares words with the tournament name
      for (const sport of golfSports) {
        const res = await fetch(
          `/api/odds?sport=${encodeURIComponent(sport)}&regions=uk,eu,us&markets=outrights&oddsFormat=decimal`
        );
        if (!res.ok) continue;
        const events = await res.json();
        if (!events.length) continue;

        for (const ev of events) {
          const evTitle = (ev.sport_title || ev.home_team || "").toLowerCase();
          const overlap = tournWords.filter(w => w.length > 3 && evTitle.includes(w)).length;
          if (overlap > 0) { bestEvent = ev; bestSport = sport; break; }
        }
        if (bestEvent) break;
        // Fallback: use first event from a likely sport key
        if (!bestEvent) { bestEvent = events[0]; bestSport = sport; }
      }

      if (!bestEvent) throw new Error("Could not find a matching golf event — try again closer to tournament start");

      // Aggregate best (lowest) decimal price per player across all bookmakers
      const bestPrice = {};
      for (const bm of (bestEvent.bookmakers || [])) {
        const market = bm.markets?.find(m => m.key === "outrights");
        if (!market) continue;
        for (const outcome of market.outcomes) {
          const key = normName(outcome.name);
          if (!bestPrice[key] || outcome.price < bestPrice[key]) bestPrice[key] = outcome.price;
        }
      }

      if (Object.keys(bestPrice).length === 0) throw new Error("No outright odds found in the API response — market may not be open yet");

      // Sort ascending (lowest price = shortest odds = biggest favourite)
      const sorted = Object.entries(bestPrice).sort((a, b) => a[1] - b[1]);
      const positions = {};
      sorted.forEach(([name], i) => { positions[name] = i + 1; });

      const eventName = bestEvent.sport_title || bestEvent.home_team || bestSport;
      await store.set(oddsKey, { positions, updatedAt: Date.now(), eventName });
      setTournamentOdds(positions);
      setOddsMsg(`✓ ${sorted.length} players ranked by odds · ${eventName}`);
    } catch (e) {
      setOddsMsg(`⚠ ${e.message}`);
    } finally {
      setOddsFetching(false);
    }
  };

  const saveTierOverride = async (playerId, tier) => {
    const updated = { ...tierOverrides };
    if (tier === null) {
      delete updated[playerId];
    } else {
      updated[playerId] = tier;
    }
    await store.set(tierKey, updated);
    setTierOverrides(updated);
  };

  const saveAutoLock = async () => {
    const err = validateAutoLockDate(autoLockInput);
    if (err) return; // datetime-local input already constrains format; reject silently
    const iso = new Date(autoLockInput + ":00").toISOString(); // no "Z" — input is local time (BST/GMT)
    await store.set(`autolock__${tournament.id}`, { time: iso, setBy: user.email, setAt: Date.now(), name: tournament.name });
    setAutoLockTime(iso);
  };

  const clearAutoLock = async () => {
    await store.del(`autolock__${tournament.id}`);
    setAutoLockTime(null);
    setAutoLockInput("");
  };

  const togglePaid = async (uid) => {
    const next = { ...paidMap, [uid]: !paidMap[uid] };
    setPaidMap(next);
    await store.set(paidKey, next);
  };

  const toggleSummaryRevealed = async () => {
    const next = !summaryRevealed;
    await store.set(summaryRevealKey, { revealed: next, by: user.email, at: Date.now() });
    setSummaryRevealed(next);
  };

  const togglePrizeRevealed = async () => {
    const next = !prizeRevealed;
    await store.set(prizeRevealKey, { revealed: next, by: user.email, at: Date.now() });
    setPrizeRevealed(next);
  };

  const savePrizePositions = async (n) => {
    setPrizePositions(n);
    await store.set(prizePositionsKey, { positions: n, by: user.email, at: Date.now() });
  };

  const savePicks = async () => {
    if (locked) return;
    // Always save to localStorage immediately — works even if Firestore is unavailable
    try { localStorage.setItem(`gf_${picksKey}`, JSON.stringify(picks)); } catch {}
    // Save to Firestore
    const ok = await store.set(picksKey, picks);
    if (!ok) {
      setSaveMsg("⚠ Save failed — picks saved locally only");
      setTimeout(() => setSaveMsg(""), 4000);
      return;
    }
    // Also update the shared picks document so the leaderboard can see everyone
    const allPicks = await store.get(allPicksKey) || {};
    allPicks[user.uid] = {
      userId:      user.uid,
      displayName: playerNames[user.uid] || user.displayName || user.email,
      picks,
      savedAt:     Date.now(),
    };
    await store.set(allPicksKey, allPicks);
    setAllEntries(Object.values(allPicks));
    setSavedPickIds(picks.map(p => p.id));
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
    setSaveMsg("✓ Team saved!");
    setTimeout(() => teamCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    setTimeout(() => setSaveMsg(""), 3000);
    logActivity(user.uid, user.email, "picks_saved", {
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      picks: picks.map(p => p.name),
    });
  };

  // Enrich players with tier — odds-based when available, world rankings as fallback
  const rankMap = Object.fromEntries(rankings.map(r => [r.id, r.rank]));
  const oddsActive = Object.keys(tournamentOdds).length > 0;
  const displayPlayers = players.map(p => {
    // Correct false-positive MC flags. ESPN returns "CUT" as the score string for BOTH
    // actual MC players AND players who made the cut but haven't teed off in R3 yet.
    // The only reliable signal is ESPN's status field (statusSaysCut). The round-count
    // heuristic (roundsMissedCut) is used as a fallback only when the score is a real
    // numeric value at or above the cut line — never when the score is the "CUT" string.
    const scoreStr = String(p.score ?? "");
    const rawIsNonNumeric = scoreStr === "" || isNaN(parseInt(scoreStr.replace("+", ""), 10));
    const effectiveCut = p.statusSaysCut ||
      (p.cut && !rawIsNonNumeric && cutScore !== null && p.rawScore >= cutScore);
    const correctedPlayStatus = (!effectiveCut && p.cut) ? "not_started" : p.playStatus;
    const { adjusted, actualScore, fantasyScore, penalised } = applyScoreRules({ ...p, cut: effectiveCut }, cutScore);
    const rank = rankMap[p.id] || null;
    const oddsPos = oddsActive ? (tournamentOdds[normName(p.name)] ?? null) : null;
    const baseTier = oddsPos !== null ? getTierForOddsPosition(oddsPos) : getTierForRank(rank);
    const tier = tierOverrides[p.id] ?? baseTier; // admin override takes precedence
    const cell = formatScoreCell(actualScore, fantasyScore, penalised);
    return { ...p, cut: effectiveCut, playStatus: correctedPlayStatus, adjusted, actualScore, fantasyScore, penalised, scoreCell: cell, rank, oddsPos, tier, baseTier };
  });

  const filtered      = displayPlayers.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  const parsePos = pos => {
    if (!pos || pos === "-") return 9999;
    if (pos === "MC" || pos === "MDF") return 9000;
    if (pos === "WD") return 9001;
    const n = parseInt(pos.replace(/\D/g, ""), 10);
    return isNaN(n) ? 9999 : n;
  };
  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };
  const sortedFiltered = [...filtered].sort((a, b) => {
    let diff = 0;
    if (sortCol === "pos")     diff = parsePos(a.position) - parsePos(b.position);
    else if (sortCol === "name")    diff = a.name.localeCompare(b.name);
    else if (sortCol === "tier")    diff = a.tier - b.tier;
    else if (sortCol === "score")   diff = a.actualScore - b.actualScore;
    else if (sortCol === "fantasy") diff = a.adjusted - b.adjusted;
    return sortDir === "asc" ? diff : -diff;
  });

  const pickedPlayers = picks.map(pk => {
    const live = displayPlayers.find(p => p.id===pk.id);
    // Use tier from displayPlayers (which already factors in odds + overrides); fall back to world rank
    const tier = live?.tier ?? getTierForRank(rankMap[pk.id] || null);
    return { ...pk, adjusted: live?.adjusted ?? 0, actualScore: live?.actualScore ?? 0, scoreCell: live?.scoreCell ?? null, cut: live?.cut, withdrawn: live?.withdrawn, tier };
  });
  const totalScore = pickedPlayers.reduce((s,p) => s + p.adjusted, 0);
  const tierSum    = pickedPlayers.reduce((s,p) => s + p.tier, 0);
  const tierOk     = picks.length < MAX_PICKS || tierSum >= TIER_MIN_SUM;
  const sc = n => n<0?"su":n>0?"so":"se";

  // Unsaved / incomplete indicators
  const teamIncomplete    = !locked && picks.length < MAX_PICKS;
  const hasUnsavedChanges = !locked && !teamIncomplete && (
    picks.length !== savedPickIds.length ||
    picks.some(p => !savedPickIds.includes(p.id))
  );

  // Count awaiting-entry users who have pre-paid (they're in paidMap but not in allEntries)
  const enteredUids = new Set(allEntries.map(e => e.userId));
  const extraPaidCount = Object.entries(paidMap).filter(([uid, paid]) => paid && !enteredUids.has(uid)).length;

  return (
    <div>
      <div style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"1rem", fontFamily:"'EB Garamond',serif", fontSize:"0.82rem"}}>
        <button className="back-btn" style={{margin:0}} onClick={onBack}>← Tournaments</button>
        <span style={{color:"var(--cream-dark)"}}>›</span>
        <span style={{color:"var(--text-dark)", fontStyle:"italic"}}>{tournament.name}</span>
      </div>
      <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"0.4rem", flexWrap:"wrap"}}>
        <div className="page-title">{tournament.name}</div>
        {isMajor(tournament.name) && <span className="inline-tag" style={{background:"var(--gold)", color:"var(--green-deep)", fontWeight:700}}>Major</span>}
        {locked   && <span className="inline-tag" style={{background:"#fce8e8", color:"#8b2020", border:"1px solid #f0b8b8"}}>Locked</span>}
        {revealed && <span className="inline-tag" style={{background:"#e8f0fc", color:"#1a3a7a", border:"1px solid #b0c8f0"}}>Entries Revealed</span>}
        <button className="pick-btn" style={{marginLeft:"auto"}} onClick={refresh} disabled={refreshing || loading}>
          {refreshing ? "↻…" : "↻ Refresh"}
        </button>
      </div>
      <div className="page-subtitle">Pick your 5 players · Live scores from ESPN</div>

      {/* Countdown to lock */}
      {!locked && lockCountdown && (() => {
        const urgent  = lockCountdownMs !== null && lockCountdownMs < 15 * 60 * 1000;
        const warning = lockCountdownMs !== null && lockCountdownMs < 60 * 60 * 1000;
        const bg      = urgent ? "#2a1a1a" : warning ? "#241e0a" : "#1a2a1a";
        const border  = urgent ? "#c03030" : warning ? "#c8a040" : "var(--gold)";
        const color   = urgent ? "#f08080" : warning ? "#d4b060" : "var(--gold-light)";
        return (
          <div style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"1rem", background:bg, border:`1px solid ${border}`, borderRadius:"3px", padding:"0.6rem 1rem", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", color}}>
            ⏱ Picks lock in <strong style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color}}>{lockCountdown}</strong>
            {urgent  && <span style={{marginLeft:"auto", fontSize:"0.78rem", opacity:0.85}}>⚠ Locking very soon</span>}
            {!urgent && warning && <span style={{marginLeft:"auto", fontSize:"0.78rem", opacity:0.85}}>⚠ Under 1 hour</span>}
          </div>
        );
      })()}

      {/* Auto-refresh indicator */}
      {(() => {
        const start = new Date(tournament.date).getTime();
        const end   = tournament.endDate ? new Date(tournament.endDate).getTime() + 24*60*60*1000 : start + 4*24*60*60*1000;
        const isLive = now >= start && now <= end;
        return isLive ? (
          <div style={{display:"flex", alignItems:"center", gap:"6px", marginBottom:"0.8rem", fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#6a9a50"}}>
            <span style={{display:"inline-block", width:"7px", height:"7px", borderRadius:"50%", background:"#4caf50", boxShadow:"0 0 6px #4caf5088"}}></span>
            Live — scores updating automatically every 2 minutes
          </div>
        ) : null;
      })()}

      <div className="tab-bar" style={{marginBottom:"1.5rem"}}>
        <div className={`tab ${view==="picks"?"active":""}`} onClick={() => setView("picks")}>
          My Picks
          <div style={{fontSize:"0.68rem", letterSpacing:0, textTransform:"none", fontStyle:"italic", opacity:0.75, marginTop:"2px", lineHeight:1}}>Choose your 5 players</div>
        </div>
        {isAdmin && (
          <div className={`tab ${view==="tiers"?"active":""}`} onClick={() => setView("tiers")}>
            Tiers
            <div style={{fontSize:"0.68rem", letterSpacing:0, textTransform:"none", fontStyle:"italic", opacity:0.75, marginTop:"2px", lineHeight:1}}>Override player tiers</div>
          </div>
        )}
        {(isAdmin || (locked && revealed)) && (
          <div className={`tab ${view==="entries"?"active":""}`} onClick={() => setView("entries")}>
            Entries ({allEntries.length})
            <div style={{fontSize:"0.68rem", letterSpacing:0, textTransform:"none", fontStyle:"italic", opacity:0.75, marginTop:"2px", lineHeight:1}}>All teams &amp; scores</div>
          </div>
        )}
        {(isAdmin || summaryRevealed) && (
          <div className={`tab ${view==="summary"?"active":""}`} onClick={() => setView("summary")}>
            Summary
            <div style={{fontSize:"0.68rem", letterSpacing:0, textTransform:"none", fontStyle:"italic", opacity:0.75, marginTop:"2px", lineHeight:1}}>Pick trends &amp; prizes</div>
          </div>
        )}
      </div>

      {view === "entries" && (isAdmin || (locked && revealed)) && (
        <AdminEntriesView entries={allEntries} players={displayPlayers} cutScore={cutScore} tournament={tournament} rankMap={rankMap} isAdmin={isAdmin} nationalityMap={nationalityMap} tournamentOdds={tournamentOdds} tierOverrides={tierOverrides} paidMap={paidMap} onTogglePaid={togglePaid} playerNames={playerNames} />
      )}

      {view === "summary" && (isAdmin || summaryRevealed) && (
        <SummaryView
          entries={allEntries}
          displayPlayers={displayPlayers}
          tournamentOdds={tournamentOdds}
          tierOverrides={tierOverrides}
          rankMap={rankMap}
          isAdmin={isAdmin}
          prizeRevealed={prizeRevealed}
          prizePositions={prizePositions}
          potOverride={potOverride}
          extraPaidCount={extraPaidCount}
        />
      )}

      {view === "tiers" && isAdmin && (
        <TierReviewView
          players={displayPlayers}
          tierOverrides={tierOverrides}
          onOverride={saveTierOverride}
          loading={loading}
        />
      )}



      {view === "picks" && (
        <div>
          {isAdmin && (
            <div className="admin-panel">
              <div className="admin-panel-title" onClick={() => setAdminOpen(o => !o)}>
                <span>Admin Controls</span>
                <span style={{fontSize:"0.8rem", transition:"transform 0.2s", display:"inline-block", transform: adminOpen ? "rotate(180deg)" : "rotate(0deg)"}}>▾</span>
              </div>

              {adminOpen && <><div className="admin-section">
                <div className="admin-label">Pick Selections <Tip text="Lock to prevent any further changes by participants. Unlock to allow edits again." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color: locked ? "#f0a0a0" : "#90d090"}}>
                    <span className={`status-dot ${locked?"red":"green"}`}></span>
                    {locked ? "Locked — no further changes allowed" : "Open — users can edit their picks"}
                  </span>
                  {locked
                    ? <button className="btn-unlock" onClick={toggleLock}>Unlock Picks</button>
                    : <button className="btn-lock"   onClick={toggleLock}>Lock All Picks</button>
                  }
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Auto-Lock Schedule <Tip text="Picks will lock automatically at this time. Set it to the first tee off so participants can't change picks once the round starts." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color:"#b8a060", fontSize:"0.82rem"}}>
                    {autoLockTime
                      ? <>{locked ? "Locked at scheduled time" : <>Scheduled: {new Date(autoLockTime).toLocaleString("en-GB",{weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:DISPLAY_TZ})} {tzLabel()} {lockCountdown && <span style={{color:"var(--gold)"}}> · {lockCountdown}</span>}</>}</>
                      : "No auto-lock set"}
                  </span>
                </div>
                {firstTeeTime && !locked && (
                  <div className="admin-row" style={{marginTop:"4px"}}>
                    <span style={{color:"#7ab07a", fontSize:"0.8rem"}}>
                      First tee time: {new Date(firstTeeTime).toLocaleString("en-GB",{weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:DISPLAY_TZ})} {tzLabel()}
                    </span>
                    <button className="btn-sm" onClick={() => {
                      const d = new Date(new Date(firstTeeTime).getTime() - 5 * 60 * 1000);
                      // Build datetime-local string in Dublin local time (handles BST/GMT)
                      const localStr = new Intl.DateTimeFormat("sv", {
                        timeZone: DISPLAY_TZ, year:"numeric", month:"2-digit", day:"2-digit",
                        hour:"2-digit", minute:"2-digit",
                      }).format(d);
                      setAutoLockInput(localStr.replace(" ", "T"));
                    }}>Use tee time (−5 min)</button>
                  </div>
                )}
                <div className="admin-row" style={{marginTop:"6px"}}>
                  <input
                    type="datetime-local"
                    value={autoLockInput}
                    onChange={e => setAutoLockInput(e.target.value)}
                    style={{padding:"4px 8px", border:"1px solid #5a7a3a", borderRadius:"2px", fontFamily:"'Crimson Text',serif", fontSize:"0.88rem", background:"#1a2a1a", color:"var(--gold-light)", outline:"none"}}
                  />
                  <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)"}}>{tzLabel()}</span>
                  <button className="btn-sm" onClick={saveAutoLock}>Set</button>
                  {autoLockTime && !locked && <button className="btn-sm warn" onClick={clearAutoLock}>Clear</button>}
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Entries Visibility <Tip text="When hidden, participants cannot see other users' picks. Reveal once picks are locked so nobody gains an advantage." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color: revealed ? "#90d090" : "#c0a060"}}>
                    <span className={`status-dot ${revealed?"green":"amber"}`}></span>
                    {revealed ? "Revealed — all users can see everyone's entries" : "Hidden — users can only see their own picks"}
                  </span>
                  {revealed
                    ? <button className="btn-hide"   onClick={toggleReveal}>Hide Entries</button>
                    : <button className="btn-reveal" onClick={toggleReveal}>Reveal Entries</button>
                  }
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Payments Collected <Tip text={`€${TOTAL_FEE} collected per person (€${ENTRY_FEE} to pot + €${ADMIN_FEE} admin fee). Track who has paid using the Paid column in the Entries tab.`} /></div>
                <div className="admin-row">
                  {(() => {
                    const paidCount = Object.values(paidMap).filter(Boolean).length;
                    const enteredPaid = allEntries.filter(e => paidMap[e.userId]).length;
                    const totalCollected = paidCount * TOTAL_FEE;
                    const enteredOutstanding = allEntries.length - enteredPaid;
                    return (
                      <span className="status-text" style={{color:"#b8a060", fontSize:"0.88rem"}}>
                        <span style={{color:"var(--gold)", fontFamily:"'Playfair Display',serif", fontSize:"1.3rem", lineHeight:1, marginRight:"6px"}}>{paidCount}</span>
                        paid
                        {extraPaidCount > 0 && <span style={{fontSize:"0.8rem", marginLeft:"4px"}}>({allEntries.length - enteredPaid} entered + {extraPaidCount} pre-entry)</span>}
                        <span style={{marginLeft:"16px", color:"#90d090", fontFamily:"'Playfair Display',serif", fontSize:"1.1rem"}}>€{totalCollected}</span>
                        <span style={{marginLeft:"4px", fontSize:"0.8rem"}}>collected</span>
                        {enteredOutstanding > 0 && <span style={{marginLeft:"12px", color:"#f08080"}}>· {enteredOutstanding} entries outstanding</span>}
                      </span>
                    );
                  })()}
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Pick Summary Visibility <Tip text="When revealed, all participants can see the top 3 most chosen golfers from each tier. Keep hidden during picks to prevent groupthink." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color: summaryRevealed ? "#90d090" : "#c0a060"}}>
                    <span className={`status-dot ${summaryRevealed?"green":"amber"}`}></span>
                    {summaryRevealed ? "Visible to all participants" : "Hidden — only visible to admin"}
                  </span>
                  {summaryRevealed
                    ? <button className="btn-hide" onClick={toggleSummaryRevealed}>Hide Summary</button>
                    : <button className="btn-reveal" onClick={toggleSummaryRevealed}>Reveal Summary</button>
                  }
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Prize Visibility <Tip text="Reveal the prize breakdown to all participants. They will see positions and amounts but not the total pot or admin fee." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color: prizeRevealed ? "#90d090" : "#c0a060"}}>
                    <span className={`status-dot ${prizeRevealed?"green":"amber"}`}></span>
                    {prizeRevealed ? "Prize breakdown visible to all participants" : "Hidden — only visible to admin"}
                  </span>
                  {prizeRevealed
                    ? <button className="btn-hide" onClick={togglePrizeRevealed}>Hide Prizes</button>
                    : <button className="btn-reveal" onClick={togglePrizeRevealed}>Reveal Prizes</button>
                  }
                </div>
              </div>

              <div className="admin-section">
                <div className="admin-label">Cut Score <Tip text="Players who miss the cut are penalised to cut+10. Everyone else's score is capped at cut+9. ESPN auto-detects this, but you can override it here." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color:"#b8a060", fontSize:"0.86rem"}}>
                    ESPN: {espnCut !== null ? formatScore(espnCut) : "not yet available"}
                    {cutOverrideActive && <span style={{color:"var(--gold-light)", marginLeft:"10px"}}>· Override active: {formatScore(cutScore)}</span>}
                  </span>
                  <input className="cut-input-sm" value={cutInput} onChange={e => setCutInput(e.target.value)} placeholder="+3 / -1" onKeyDown={e=>e.key==="Enter"&&applyCutOverride()} />
                  <button className="btn-sm" onClick={applyCutOverride}>Apply</button>
                  {cutOverrideActive && <button className="btn-sm warn" onClick={clearCutOverride}>Clear Override</button>}
                </div>
                <div style={{fontFamily:"'EB Garamond', serif", fontSize:"0.76rem", color:"#6a7a50", marginTop:"6px"}}>
                  Missed cut / WD → cut+10 · Made cut score capped at cut+9
                </div>
                {/* Audit trail */}
                {cutAudit && (
                  <div style={{marginTop:"8px", padding:"6px 10px", background:"rgba(201,168,76,0.06)", border:"1px solid rgba(201,168,76,0.2)", borderRadius:"2px", fontFamily:"'EB Garamond',serif", fontSize:"0.75rem", color:"#8a7840"}}>
                    Set by <strong style={{color:"var(--gold-light)"}}>{cutAudit.setBy}</strong> on {new Date(cutAudit.setAt).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}
                    {espnCut !== null && cutScore !== espnCut && <span style={{marginLeft:"8px", color:"#6a5830"}}>· ESPN shows {formatScore(espnCut)}</span>}
                  </div>
                )}
                {!cutAudit && espnCut !== null && (
                  <div style={{marginTop:"8px", fontFamily:"'EB Garamond',serif", fontSize:"0.75rem", color:"#6a7a50"}}>
                    Source: ESPN (auto) · No manual override set
                  </div>
                )}
              </div>

              <div className="admin-section">
                <div className="admin-label">Tournament Odds <Tip text="Fetch pre-tournament betting odds from The Odds API to assign tiers. Favourites (short prices) land in T1/T2, longshots in T4/T5 — LIV players and unranked golfers are priced fairly. Fetch once before picks lock. Falls back to world rankings for any player not in the odds." /></div>
                <div className="admin-row">
                  <span className="status-text" style={{color:"#b8a060", fontSize:"0.82rem"}}>
                    {oddsMsg
                      ? <span style={{color: oddsMsg.startsWith("✓") ? "#90d090" : "#f08080"}}>{oddsMsg}</span>
                      : "Fetch odds to set tiers — works for LIV players too"}
                  </span>
                  <button className="btn-sm" onClick={fetchTournamentOdds} disabled={oddsFetching}>
                    {oddsFetching ? "Fetching…" : "↻ Fetch Odds"}
                  </button>
                </div>
              </div>

              {/* ── Prize Money ── */}
              {(() => {
                const entryCount = allEntries.length + extraPaidCount;
                const autoPot   = entryCount * ENTRY_FEE;
                const adminTotal = entryCount * ADMIN_FEE;
                const pot       = potOverride !== null ? potOverride : autoPot;

                // Find the max positions where the bottom prize stays >= MIN_BOTTOM_PRIZE
                const computeAmounts = n => {
                  const s = computePrizeSplits(n);
                  return s.map((pct, i) => {
                    if (i < s.length - 1) return Math.round(pot * pct / 100);
                    const prev = s.slice(0, -1).reduce((sum, p) => sum + Math.round(pot * p / 100), 0);
                    return pot - prev;
                  });
                };
                let maxPositions = 1;
                for (let n = 1; n <= MAX_PRIZE_POSITIONS; n++) {
                  const testAmts = computeAmounts(n);
                  if (testAmts[testAmts.length - 1] >= MIN_BOTTOM_PRIZE) maxPositions = n;
                  else break;
                }

                const positions = Math.min(prizePositions ?? defaultPrizePositions(entryCount), maxPositions);
                const splits    = computePrizeSplits(positions);
                const ordinals  = ["1st","2nd","3rd","4th","5th","6th","7th","8th","9th","10th"];
                const amounts   = computeAmounts(positions);
                return (
                  <div className="admin-section" style={{paddingBottom:0, borderBottom:"none"}}>
                    <div className="admin-label">Prize Money <Tip text={`€${ENTRY_FEE}/person goes to the prize pot. €${ADMIN_FEE}/person is retained as an admin fee. 1st place always receives 40% of the pot; other positions use linearly-decreasing weights.`} /></div>

                    {/* Pot + admin fee row */}
                    <div style={{display:"flex", gap:"1rem", flexWrap:"wrap", alignItems:"flex-start", marginBottom:"0.85rem"}}>
                      {/* Prize pot */}
                      <div style={{flex:"1 1 160px", background:"rgba(201,168,76,0.06)", border:"1px solid rgba(201,168,76,0.2)", borderRadius:"4px", padding:"0.6rem 0.9rem"}}>
                        <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"#9a8850", marginBottom:"4px"}}>
                          Prize Pot {potOverride !== null && <span style={{color:"#f08040"}}>(overridden)</span>}
                        </div>
                        <div style={{display:"flex", alignItems:"baseline", gap:"8px", flexWrap:"wrap"}}>
                          <span style={{fontFamily:"'Playfair Display',serif", fontSize:"1.6rem", color:"var(--gold)", lineHeight:1}}>€{pot.toLocaleString()}</span>
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"#9a8850"}}>
                            {potOverride !== null ? `manual override (auto: €${autoPot})` : extraPaidCount > 0 ? `${allEntries.length} entries + ${extraPaidCount} pre-paid × €${ENTRY_FEE}` : `${entryCount} × €${ENTRY_FEE}`}
                          </span>
                        </div>
                        {/* Override controls */}
                        <div style={{display:"flex", alignItems:"center", gap:"6px", marginTop:"6px", flexWrap:"wrap"}}>
                          {potOverride === null ? (
                            <button className="btn-sm" style={{fontSize:"0.72rem", padding:"2px 8px"}} onClick={() => { setPotOverride(autoPot); setPotInput(String(autoPot)); }}>Override pot</button>
                          ) : (
                            <>
                              <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#9a8850"}}>€</span>
                              <input
                                type="number" min="0"
                                value={potInput}
                                onChange={e => setPotInput(e.target.value)}
                                onBlur={() => { const v = parseInt(potInput, 10); if (!isNaN(v) && v >= 0) setPotOverride(v); else { setPotOverride(autoPot); setPotInput(String(autoPot)); } }}
                                style={{width:"80px", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", background:"#1a2a1a", border:"1px solid rgba(201,168,76,0.35)", borderRadius:"3px", color:"var(--gold)", padding:"2px 6px"}}
                              />
                              <button className="btn-sm" style={{fontSize:"0.72rem", padding:"2px 8px"}} onClick={() => { setPotOverride(null); setPotInput(""); }}>Reset</button>
                            </>
                          )}
                        </div>
                      </div>
                      {/* Admin fee */}
                      <div style={{flex:"1 1 140px", background:"rgba(120,120,120,0.06)", border:"1px solid rgba(120,120,120,0.15)", borderRadius:"4px", padding:"0.6rem 0.9rem"}}>
                        <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"4px"}}>Admin Fee</div>
                        <div style={{fontFamily:"'Playfair Display',serif", fontSize:"1.6rem", color:"var(--text-mid)", lineHeight:1}}>€{adminTotal}</div>
                        <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"var(--text-light)", marginTop:"2px"}}>{entryCount} × €{ADMIN_FEE}</div>
                      </div>
                    </div>

                    {/* Positions control */}
                    <div style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"0.75rem", flexWrap:"wrap"}}>
                      <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#9a8850", textTransform:"uppercase", letterSpacing:"0.08em"}}>Paid positions</span>
                      <button className="btn-sm" style={{padding:"2px 9px"}} onClick={() => savePrizePositions(Math.max(1, positions - 1))} disabled={positions <= 1}>−</button>
                      <span style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color:"var(--gold)", minWidth:"18px", textAlign:"center"}}>{positions}</span>
                      <button className="btn-sm" style={{padding:"2px 9px"}} onClick={() => savePrizePositions(Math.min(maxPositions, positions + 1))} disabled={positions >= maxPositions}>+</button>
                      <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", color:"#9a8850", fontStyle:"italic"}}>
                        {positions >= maxPositions ? `capped — bottom prize < €${MIN_BOTTOM_PRIZE} if more` : `max ${maxPositions}`}
                      </span>
                    </div>

                    {entryCount === 0 && potOverride === null ? (
                      <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", color:"#9a8850", fontStyle:"italic"}}>No entries yet — pot will update as players enter.</div>
                    ) : (
                      <div style={{display:"flex", flexDirection:"column", gap:"5px"}}>
                        {splits.map((pct, i) => {
                          const amt = amounts[i];
                          const isFirst = i === 0;
                          return (
                            <div key={i} style={{display:"flex", alignItems:"center", gap:"10px"}}>
                              <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color: isFirst ? "var(--gold)" : "#9a8850", width:"30px", textAlign:"right", letterSpacing:"0.02em", flexShrink:0}}>{ordinals[i]}</div>
                              <div style={{flex:1, height:"5px", borderRadius:"3px", background:"rgba(201,168,76,0.1)", overflow:"hidden", minWidth:"40px"}}>
                                <div style={{width:`${pct}%`, height:"100%", background: isFirst ? "var(--gold)" : "rgba(201,168,76,0.4)", borderRadius:"3px"}} />
                              </div>
                              <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#9a8850", width:"34px", textAlign:"right", flexShrink:0}}>{pct}%</div>
                              <div style={{fontFamily:"'Playfair Display',serif", fontSize:"0.92rem", color: isFirst ? "var(--gold)" : "#c8a850", width:"52px", textAlign:"right", flexShrink:0}}>€{amt}</div>
                            </div>
                          );
                        })}
                        <div style={{marginTop:"6px", paddingTop:"6px", borderTop:"1px solid rgba(201,168,76,0.1)", display:"flex", justifyContent:"flex-end", gap:"10px"}}>
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", color:"#9a8850"}}>Total paid out</span>
                          <span style={{fontFamily:"'Playfair Display',serif", fontSize:"0.88rem", color:"var(--gold)", width:"52px", textAlign:"right"}}>€{amounts.reduce((s,a) => s+a, 0)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              </>}
            </div>
          )}

          {locked && !isAdmin && (
            <div className="lock-banner">
              <div>
                <strong>Picks are locked for this tournament</strong>
                The selection window has closed. Your team is set — good luck!
              </div>
            </div>
          )}

          {cutScore !== null && (
            <div className="cut-banner">
              <div className="cut-info">
                Cut line: <strong>{formatScore(cutScore)}</strong>
                <span style={{marginLeft:"14px", fontSize:"0.8rem", opacity:0.8}}>
                  MC / WD → {formatScore(cutScore+10)} · Cap for qualifiers → {formatScore(cutScore+9)}
                  {cutOverrideActive && <span style={{marginLeft:"8px", color:"#8b6010"}}>(admin override)</span>}
                </span>
              </div>
            </div>
          )}

          {/* Prize banner for non-admin when prizes are revealed */}
          {!isAdmin && prizeRevealed && (() => {
            const entryCount = allEntries.length + extraPaidCount;
            const pot = entryCount * ENTRY_FEE;
            const computeAmounts = n => {
              const s = computePrizeSplits(n);
              return s.map((pct, i) => {
                if (i < s.length - 1) return Math.round(pot * pct / 100);
                const prev = s.slice(0, -1).reduce((sum, p) => sum + Math.round(pot * p / 100), 0);
                return pot - prev;
              });
            };
            let maxPos = 1;
            for (let n = 1; n <= MAX_PRIZE_POSITIONS; n++) {
              const a = computeAmounts(n);
              if (a[a.length - 1] >= MIN_BOTTOM_PRIZE) maxPos = n; else break;
            }
            const pos = Math.min(prizePositions ?? defaultPrizePositions(entryCount), maxPos);
            const amounts = computeAmounts(pos);
            const ordinals = ["1st","2nd","3rd","4th","5th","6th","7th","8th","9th","10th"];
            if (entryCount === 0) return null;
            return (
              <div style={{background:"var(--gold-pale)", border:"1px solid #d4b96a", borderRadius:"4px", padding:"0.9rem 1.2rem", marginBottom:"1.2rem"}}>
                <div style={{fontFamily:"'Playfair Display',serif", fontSize:"0.95rem", color:"var(--green-deep)", marginBottom:"0.6rem", fontWeight:600}}>Prize Breakdown</div>
                <div style={{display:"flex", gap:"1rem", flexWrap:"wrap"}}>
                  {amounts.map((amt, i) => (
                    <div key={i} style={{display:"flex", alignItems:"center", gap:"6px", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem"}}>
                      <span style={{color: i === 0 ? "var(--gold)" : "#7a5a10", fontWeight:600}}>{ordinals[i]}</span>
                      <span style={{color:"#5a4010", fontFamily:"'Playfair Display',serif", fontWeight:700}}>€{amt}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Tier warning — shown when saved picks fall below minimum tier sum due to odds update */}
          {!locked && picks.length === MAX_PICKS && !tierOk && savedPickIds.length > 0 && (
            <div style={{display:"flex", alignItems:"flex-start", gap:"10px", marginBottom:"1rem", background:"#2a1500", border:"1px solid #c8803055", borderRadius:"3px", padding:"0.75rem 1rem", fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", color:"#d09060"}}>
              <span style={{fontSize:"1.2rem", flexShrink:0}}>⚠</span>
              <div>
                <strong style={{color:"#e8a050", display:"block", marginBottom:"2px"}}>Your team needs updating</strong>
                Tiers have been recalculated using betting odds. Your current tier sum is <strong style={{color:"#e8a050"}}>{tierSum}</strong> — the minimum is <strong style={{color:"#e8a050"}}>{TIER_MIN_SUM}</strong>. Swap one of your higher-tier picks for a longer-shot player and re-save your team.
              </div>
            </div>
          )}

          {/* Pick progress indicator — only shown when picks are not locked */}
          {!locked && (() => {
            const step1Done = picks.length === MAX_PICKS;
            const step2Done = step1Done && tierOk;
            const step3Done = step2Done && !hasUnsavedChanges && savedPickIds.length > 0;
            const activeStep = step3Done ? 3 : step2Done ? 3 : step1Done ? 2 : 1;
            return (
              <div className="pick-progress">
                <div className={`pick-step ${step1Done ? "done" : activeStep === 1 ? "active" : ""}`}>
                  <div className="step-num"><span>{step1Done ? "✓" : "1"}</span></div>
                  Choose 5 players
                </div>
                <div className={`pick-step ${step2Done ? "done" : activeStep === 2 ? "active" : ""}`}>
                  <div className="step-num"><span>{step2Done ? "✓" : "2"}</span></div>
                  Reach tier sum {TIER_MIN_SUM}
                </div>
                <div className={`pick-step ${step3Done ? "done" : activeStep === 3 ? "active" : ""}`}>
                  <div className="step-num"><span>{step3Done ? "✓" : "3"}</span></div>
                  Save your team
                </div>
              </div>
            );
          })()}

          {/* Empty state guidance — shown when user has no picks yet and picks aren't locked */}
          {!locked && savedPickIds.length === 0 && picks.length === 0 && (
            <div style={{background:"var(--gold-pale)", border:"1px solid #d4b96a", borderRadius:"4px", padding:"1.2rem 1.6rem", marginBottom:"0.5rem", fontFamily:"'EB Garamond',serif"}}>
              <div style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color:"var(--green-deep)", marginBottom:"0.5rem", fontWeight:600}}>How to enter this tournament</div>
              <ol style={{margin:0, paddingLeft:"1.4rem", color:"#5a4010", lineHeight:1.8, fontSize:"0.9rem"}}>
                <li>Pick <strong>5 players</strong> from the leaderboard below</li>
                <li>Your team's <strong>tier numbers must add up to at least {TIER_MIN_SUM}</strong> — this stops everyone picking the same top 5</li>
                <li><strong>Save your team</strong> before picks lock — you can edit up until then</li>
              </ol>
            </div>
          )}

          <div className="picks-layout">
            <div className="section-card">
              <div className="s-head">
                <div>
                  <div className="s-head-title">Live Leaderboard</div>
                  <div className="s-head-sub">{locked ? "Picks locked" : "Click a player to pick or remove"}</div>
                </div>
                <div style={{display:"flex", alignItems:"center", gap:"10px"}}>
                  <span className="picks-count-badge">{picks.length}/{MAX_PICKS}</span>
                  <button className="pick-btn" onClick={refresh}>{refreshing?"↻…":"↻ Refresh"}</button>
                </div>
              </div>
              {/* Tier legend */}
              <div style={{padding:"0.5rem 1.4rem", display:"flex", gap:"6px", flexWrap:"wrap", borderBottom:"1px solid var(--cream-dark)", background:"var(--cream)"}}>
                {TIER_BANDS.map(b => (
                  <span key={b.tier} style={{display:"flex", alignItems:"center", gap:"4px", fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", color:"var(--text-light)"}}>
                    <span style={{display:"inline-block", background:b.bg, color:b.color, border:`1px solid ${b.color}44`, borderRadius:"2px", fontWeight:700, padding:"1px 5px", fontSize:"0.68rem"}}>T{b.tier}</span>
                    Rank {b.min}{b.max < 9999 ? `–${b.max}` : "+"}
                  </span>
                ))}
                <span style={{marginLeft:"auto", fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", color:"var(--text-light)"}}>
                  Min tier sum: <strong style={{color:"var(--gold)"}}>{TIER_MIN_SUM}</strong>
                </span>
              </div>
              {!locked && picks.length === 0 && (
                <div className="first-pick-nudge">
                  <span className="nudge-arrow">↓</span>
                  Tap any player below to add them to your team
                </div>
              )}
              <div className="search-wrap">
                <input className="search-input" placeholder="Search players…" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              {players.length > 0 && (
                <div className="footnote" style={{display:"flex", gap:"1.2rem", flexWrap:"wrap"}}>
                  <span><span className="player-dot dot-grey" style={{display:"inline-block"}}></span> Not started</span>
                  <span><span className="player-dot dot-green" style={{display:"inline-block"}}></span> Playing</span>
                  <span><span className="player-dot dot-blue" style={{display:"inline-block"}}></span> Round complete</span>
                  <span><span className="player-dot dot-red" style={{display:"inline-block"}}></span> MC / WD</span>
                  {cutScore !== null && <span style={{marginLeft:"auto"}}>* Fantasy adjusted: MC/WD → cut+10 · cap at cut+9</span>}
                </div>
              )}
              {loading
                ? <div className="loading">Loading leaderboard…</div>
                : players.length === 0
                  ? <div className="empty">No player data yet.<br/>This tournament may not have started, or ESPN hasn't published scores.</div>
                  : (
                    <>
                      <div className="lb-table-wrap">
                      <table className="lb-table">
                        <thead>
                          <tr>
                            {[
                              { col:"pos",     label:"#",       style:{textAlign:"center"} },
                              { col:"name",    label:"Player",  style:{} },
                              { col:"tier",    label:"Tier", style:{textAlign:"center", width:"1px", whiteSpace:"nowrap"} },
                              { col:"score",   label:"Actual",  style:{textAlign:"right"}, className:"col-score" },
                              { col:"fantasy", label:<>Score <Tip text="Fantasy score for the sweep. MC/WD players score cut+10. All others are capped at cut+9. Shown with * when cut has been applied." /></>, style:{textAlign:"center", color:"var(--gold)"} },
                            ].map(({ col, label, style, className: extraClass }) => (
                              <th key={col} className={`sortable${sortCol===col?" sort-active":""}${extraClass?" "+extraClass:""}`} style={style}
                                onClick={() => handleSort(col)}>
                                {label}<span className="sort-icon">{sortCol===col ? (sortDir==="asc"?"▲":"▼") : "▲"}</span>
                              </th>
                            ))}
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedFiltered.map(p => {
                            const isPicked = picks.some(pk => pk.id===p.id);
                            const canAdd   = isPicked || picks.length < MAX_PICKS;
                            return (
                              <tr key={p.id}
                                  className={`${isPicked?"is-picked":""} ${(p.cut||p.withdrawn)?"is-cut":""}`}
                                  onClick={() => !locked && togglePick(p)}
                                  style={{cursor: locked?"default":"pointer"}}
                              >
                                <td className="pos-c">{p.position}</td>
                                <td className="name-c">
                                  <span className={`player-dot ${p.playStatus==="cut_wd"?"dot-red":p.playStatus==="finished"?"dot-blue":p.playStatus==="not_started"?"dot-grey":"dot-green"}`}></span>
                                  {p.name}
                                </td>
                                <td style={{textAlign:"center", width:"1px", whiteSpace:"nowrap"}}>
                                  <TierBadge tier={p.tier} rank={p.rank} />
                                </td>
                                <td className="col-score" style={{textAlign:"right", fontSize:"0.88rem"}}>
                                  {p.cut
                                    ? <span style={{color:"#e05050", fontWeight:700, fontSize:"0.75rem", letterSpacing:"0.06em"}}>CUT</span>
                                    : p.withdrawn
                                      ? <span style={{color:"#e05050", fontWeight:700, fontSize:"0.75rem", letterSpacing:"0.06em"}}>WD</span>
                                      : <span className={sc(p.actualScore)}>{formatScore(p.actualScore)}</span>
                                  }
                                </td>
                                <td style={{textAlign:"center"}}>
                                  {p.scoreCell?.fantasy != null
                                    ? <span style={{color: p.scoreCell.penalised?"#e05050":"#5b9bd5", fontWeight:600, fontSize:"0.88rem"}}>{p.scoreCell.fantasy}</span>
                                    : (p.cut || p.withdrawn)
                                      ? <span style={{color:"#e05050", fontWeight:600, fontSize:"0.88rem"}}>—</span>
                                      : <span style={{fontWeight:600, fontSize:"0.88rem"}} className={sc(p.actualScore)}>{formatScore(p.actualScore)}</span>
                                  }
                                </td>
                                <td style={{width:"1px", whiteSpace:"nowrap"}}>
                                  {!locked && (
                                    <button className={`pick-btn ${isPicked?"on":""}`} disabled={!canAdd}
                                      onClick={e => { e.stopPropagation(); togglePick(p); }}>
                                      <span className="btn-full">{isPicked ? "✓ Picked" : "Pick"}</span>
                                      <span className="btn-icon">{isPicked ? "✓" : "+"}</span>
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      </div>
                    </>
                  )
              }
            </div>

            <div className="picks-team-card">
              <div ref={teamCardRef} className={`team-card${saveSuccess?" save-confirmed":""}`} style={{position:"relative"}}>
                {saveSuccess && (
                  <div className="save-check-overlay">
                    <div className="save-check-icon">✓</div>
                    <div className="save-check-label">Team Saved!</div>
                  </div>
                )}
                <div className="team-head">
                  <div className="team-title">My Team <Tip text="Your 5 selected players. Hit Save to submit your team — you can update picks any time before they are locked." /></div>
                  <div style={{color:"var(--green-pale)", fontSize:"0.76rem", fontFamily:"'EB Garamond',serif", marginTop:"3px"}}>
                    {tournament.shortName||tournament.name}
                  </div>
                </div>
                <div className="team-body">
                  {Array.from({length:MAX_PICKS}).map((_,i) => {
                    const p = pickedPlayers[i];
                    return (
                      <div key={i} className="t-slot">
                        {p ? (
                          <>
                            <div style={{flex:1, minWidth:0}}>
                              <div style={{display:"flex", alignItems:"center", gap:"6px"}}>
                                <TierBadge tier={p.tier} compact />
                                <div className="t-slot-name">{p.name}</div>
                              </div>
                              {(p.cut||p.withdrawn) && <div className="t-slot-tag">{p.cut?"Missed cut":"Withdrawn"}</div>}
                            </div>
                            <div style={{display:"flex", alignItems:"center", gap:"6px"}}>
                              {p.scoreCell?.fantasy != null ? (
                                <>
                                  <span style={{color:"var(--text-light)", fontSize:"0.78rem", textDecoration: p.scoreCell.penalised?"line-through":""}}>{formatScore(p.actualScore)}</span>
                                  <span style={{color: p.scoreCell.penalised?"#e05050":"#5b9bd5", fontWeight:600, fontSize:"0.88rem"}}>→{p.scoreCell.fantasy}</span>
                                </>
                              ) : (p.cut || p.withdrawn) ? (
                                <span style={{color:"#e05050", fontWeight:600, fontSize:"0.88rem"}}>—</span>
                              ) : (
                                <span className={sc(p.adjusted)}>{formatScore(p.actualScore)}</span>
                              )}
                              {!locked && <button className="t-remove" onClick={() => togglePick(p)}>×</button>}
                            </div>
                          </>
                        ) : (
                          <span className="t-slot-empty">Pick {i+1} — empty</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="team-total">
                  <span className="team-total-label">Team Total</span>
                  <span className="team-total-score" style={{color: totalScore<0?"#6fba58":totalScore>0?"#e08080":"var(--gold)"}}>
                    {formatScore(totalScore)}
                  </span>
                </div>
                {/* Tier sum indicator */}
                <div className="team-tier-sum" style={{padding:"0.5rem 1.4rem", borderTop:"1px solid rgba(255,255,255,0.06)"}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", letterSpacing:"0.08em", textTransform:"uppercase", color: tierOk ? "#90d090" : "#d09060"}}>
                      Tier Sum <Tip text="Your 5 picks must have a combined tier sum of at least 13. This stops everyone just picking the 5 highest-ranked players." />
                    </span>
                    <span style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color: tierOk ? "#90d090" : "#d09060", fontWeight:600}}>
                      {tierSum} / {TIER_MIN_SUM}
                      {picks.length === MAX_PICKS && !tierOk && <span style={{fontSize:"0.7rem", marginLeft:"6px"}}>↑ need {TIER_MIN_SUM - tierSum} more</span>}
                    </span>
                  </div>
                  {picks.length === MAX_PICKS && !tierOk && (
                    <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", color:"#c08040", marginTop:"4px", lineHeight:1.4}}>
                      Your tier sum is {tierSum} — you need {TIER_MIN_SUM - tierSum} more. Swap a Tier 1 or 2 pick for a Tier 3, 4, or 5 player.
                    </div>
                  )}
                </div>
                {/* Picks status bar — visible when not locked */}
                {!locked && (
                  <div className={`picks-status-bar ${teamIncomplete ? "incomplete" : (picks.length === MAX_PICKS && !tierOk) ? "unsaved" : hasUnsavedChanges ? "unsaved" : savedPickIds.length > 0 ? "saved" : ""}`}>
                    {teamIncomplete ? (
                      <>{picks.length} / {MAX_PICKS} players selected — complete your team to save</>
                    ) : (picks.length === MAX_PICKS && !tierOk) ? (
                      <>⚠ Tier sum too low — swap a player and re-save your team</>
                    ) : hasUnsavedChanges ? (
                      <>⚠ Unsaved changes — hit Save My Team to confirm</>
                    ) : savedPickIds.length > 0 ? (
                      <>✓ Team saved</>
                    ) : null}
                  </div>
                )}
                <div className="team-save" style={{padding:"0.8rem 1.4rem"}}>
                  {locked ? (
                    <div style={{textAlign:"center", fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", color:"#9a3030", padding:"0.65rem", background:"#fce8e8", borderRadius:"2px", letterSpacing:"0.04em"}}>
                      Picks are locked
                    </div>
                  ) : (
                    <>
                      {saveMsg.startsWith("✓") && (
                        <div style={{background:"#1a3a1a", border:"1px solid #4a8a4a", borderRadius:"3px", padding:"0.5rem 1rem", marginBottom:"0.6rem", fontFamily:"'EB Garamond',serif", fontSize:"0.9rem", color:"#90d090", textAlign:"center", letterSpacing:"0.04em"}}>
                          {saveMsg}
                        </div>
                      )}
                      <button
                        className={`btn-save${hasUnsavedChanges ? " has-changes" : ""}`}
                        onClick={savePicks}
                        disabled={picks.length===0 || !tierOk}
                      >
                        {saveMsg.startsWith("⚠") ? saveMsg : (hasUnsavedChanges ? "Save My Team ●" : "Save My Team")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tournament Leaderboard (all golfers, no picks context) ───────────────────
// ─── TierBadge Component ─────────────────────────────────────────────────────
function TierBadge({ tier, rank, compact }) {
  const info = getTierInfo(tier);
  if (compact) {
    return (
      <span style={{
        display: "inline-block",
        background: info.bg,
        color: info.color,
        border: `1px solid ${info.color}44`,
        borderRadius: "2px",
        fontFamily: "'EB Garamond', serif",
        fontSize: "0.65rem",
        fontWeight: 700,
        letterSpacing: "0.06em",
        padding: "1px 5px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}>T{tier}</span>
    );
  }
  return (
    <span title={rank ? `World Rank #${rank}` : "Unranked (default Tier 3)"} style={{
      display: "inline-block",
      background: info.bg,
      color: info.color,
      border: `1px solid ${info.color}44`,
      borderRadius: "2px",
      fontFamily: "'EB Garamond', serif",
      fontSize: "0.7rem",
      fontWeight: 700,
      letterSpacing: "0.06em",
      padding: "2px 7px",
      cursor: "default",
      whiteSpace: "nowrap",
    }}>T{tier}</span>
  );
}

// ─── Admin Entries View ───────────────────────────────────────────────────────
function AdminEntriesView({ entries, players, cutScore, tournament, rankMap = {}, isAdmin = false, nationalityMap = {}, tournamentOdds = {}, tierOverrides = {}, paidMap = {}, onTogglePaid, playerNames = {} }) {
  const [sortCol, setSortCol] = useState('savedAt');
  const [sortDir, setSortDir] = useState('desc');
  const [confirmUnpaidUid, setConfirmUnpaidUid] = useState(null);

  const handlePaidClick = (uid) => {
    if (paidMap[uid]) {
      // Currently paid → show confirmation before marking unpaid
      setConfirmUnpaidUid(uid);
    } else {
      // Not paid → mark paid immediately
      onTogglePaid(uid);
    }
  };

  const sc = n => n<0?"su":n>0?"so":"se";

  // Resolve tier using the same priority as the main picks view:
  // admin override → betting odds position → world ranking
  const oddsActive = Object.keys(tournamentOdds).length > 0;
  const getPickTier = pk => {
    if (!pk) return 3;
    if (tierOverrides[pk.id] !== undefined) return tierOverrides[pk.id];
    const oddsPos = oddsActive ? (tournamentOdds[normName(pk.name)] ?? null) : null;
    if (oddsPos !== null) return getTierForOddsPosition(oddsPos);
    return getTierForRank(rankMap[pk.id] || null);
  };

  const handleSort = col => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      // sensible default direction per column type
      setSortDir(col === 'savedAt' ? 'desc' : col === 'displayName' ? 'asc' : col === 'total' ? 'asc' : col === 'tierSum' ? 'desc' : col === 'paid' ? 'asc' : 'asc');
    }
  };

  const SortIcon = ({ col }) => (
    <span style={{marginLeft:"4px", opacity: sortCol === col ? 1 : 0.3, fontSize:"0.75rem"}}>
      {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  const SortTh = ({ col, children, style }) => (
    <th style={{cursor:"pointer", userSelect:"none", whiteSpace:"nowrap", ...style}} onClick={() => handleSort(col)}>
      {children}<SortIcon col={col} />
    </th>
  );

  const formatSavedAt = ts => {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  };

  if (entries.length === 0) {
    return (
      <div className="section-card">
        <div className="s-head">
          <div>
            <div className="s-head-title">All Entries</div>
            <div className="s-head-sub">{tournament.name}</div>
          </div>
        </div>
        <div className="empty" style={{padding:"2rem"}}>No entries saved for this tournament yet.</div>
      </div>
    );
  }

  // Compute scores and tier sums for each entry
  const withScores = entries.map(entry => {
    const picksWithScores = (entry.picks || []).map(pk => {
      const live = players.find(p => p.id === pk.id);
      if (!live) return { ...pk, display: "–", adjusted: 0, found: false };
      const { adjusted, actualScore, fantasyScore, penalised } = applyScoreRules(live, cutScore);
      const scoreCell = formatScoreCell(actualScore, fantasyScore, penalised);
      const displayVal = scoreCell.fantasy ?? ((live.cut || live.withdrawn) ? "—" : formatScore(actualScore));
      return { ...pk, display: displayVal, adjusted, found: true };
    });
    const total = picksWithScores.filter(p => p.found).reduce((s, p) => s + p.adjusted, 0);
    const tierSum = picksWithScores.reduce((s, pk) => s + getPickTier(pk), 0);
    return { ...entry, picksWithScores, total, tierSum };
  });

  // Score-based rank (always by total, independent of display sort)
  const byScore = [...withScores].sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    return (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase());
  });
  const scoreRank = Object.fromEntries(byScore.map((e, i) => [e.userId, i]));

  // Display sort
  const sorted = [...withScores].sort((a, b) => {
    if (sortCol === 'displayName') {
      const cmp = (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase());
      return sortDir === 'asc' ? cmp : -cmp;
    }
    if (sortCol.startsWith('pick')) {
      const pi = parseInt(sortCol.replace('pick', ''));
      const cmp = (a.picksWithScores[pi]?.name || '').toLowerCase().localeCompare((b.picksWithScores[pi]?.name || '').toLowerCase());
      return sortDir === 'asc' ? cmp : -cmp;
    }
    let va, vb;
    if (sortCol === 'savedAt') { va = a.savedAt || 0; vb = b.savedAt || 0; }
    else if (sortCol === 'total') { va = a.total; vb = b.total; }
    else if (sortCol === 'tierSum') { va = a.tierSum; vb = b.tierSum; }
    else if (sortCol === 'paid') { va = paidMap[a.userId] ? 1 : 0; vb = paidMap[b.userId] ? 1 : 0; }
    else { va = 0; vb = 0; }
    const diff = sortDir === 'asc' ? va - vb : vb - va;
    if (diff !== 0) return diff;
    return (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase());
  });

  const paidCount = isAdmin ? Object.values(paidMap).filter(Boolean).length : 0;
  const totalCollected = paidCount * TOTAL_FEE;

  return (
    <div className="section-card">
      {/* Confirmation modal for marking unpaid */}
      {confirmUnpaidUid && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"var(--white)",borderRadius:"6px",padding:"1.5rem 2rem",maxWidth:"360px",width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:"1.1rem",color:"var(--green-deep)",marginBottom:"0.75rem"}}>Mark as Unpaid?</div>
            <div style={{fontFamily:"'EB Garamond',serif",fontSize:"0.92rem",color:"var(--text-mid)",marginBottom:"1.25rem"}}>
              Are you sure you want to mark <strong>{playerNames[confirmUnpaidUid] || entries.find(e => e.userId === confirmUnpaidUid)?.displayName || confirmUnpaidUid}</strong> as unpaid? Their entry fee will be recorded as outstanding.
            </div>
            <div style={{display:"flex",gap:"0.75rem",justifyContent:"flex-end"}}>
              <button className="btn-sm" onClick={() => setConfirmUnpaidUid(null)}>Cancel</button>
              <button
                className="btn-sm warn"
                onClick={() => { onTogglePaid(confirmUnpaidUid); setConfirmUnpaidUid(null); }}
              >Mark Unpaid</button>
            </div>
          </div>
        </div>
      )}
      <div className="s-head">
        <div>
          <div className="s-head-title">All Entries</div>
          <div className="s-head-sub">{entries.length} participant{entries.length !== 1 ? "s" : ""} · {tournament.name}</div>
        </div>
        {isAdmin && entries.length > 0 && (
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"'Playfair Display',serif", fontSize:"1.3rem", color:"var(--gold)", lineHeight:1}}>€{totalCollected}</div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", color:"var(--green-pale)", marginTop:"2px"}}>{paidCount}/{entries.length} paid</div>
          </div>
        )}
      </div>
      <div style={{overflowX:"auto", width:"100%"}}>
        <table className="lb-table" style={{minWidth:"500px"}}>
          <thead>
            <tr>
              <SortTh col="total" style={{width:"40px", textAlign:"left"}}>#</SortTh>
              <SortTh col="displayName">Participant</SortTh>
              {isAdmin && <SortTh col="paid" style={{textAlign:"center"}}>Paid</SortTh>}
              <SortTh col="pick0">Pick 1</SortTh>
              <SortTh col="pick1">Pick 2</SortTh>
              <SortTh col="pick2">Pick 3</SortTh>
              <SortTh col="pick3">Pick 4</SortTh>
              <SortTh col="pick4">Pick 5</SortTh>
              <SortTh col="tierSum" style={{textAlign:"center"}}>Tier Sum</SortTh>
              <SortTh col="savedAt" style={{textAlign:"center"}}>Saved</SortTh>
              <SortTh col="total" style={{textAlign:"right"}}>Total</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const rank = scoreRank[entry.userId];
              return (
                <tr key={entry.userId} style={{cursor:"default"}}>
                  <td className="pos-c" style={{fontFamily:"'Playfair Display',serif", color:"var(--gold)"}}>
                    {`#${rank+1}`}
                  </td>
                  <td className="name-c" style={{fontWeight:600}}>
                    <div style={{display:"flex", alignItems:"center", gap:"6px"}}>
                      {nationalityMap[entry.userId] && <NatFlag nationality={nationalityMap[entry.userId]} />}
                      {playerNames[entry.userId] || entry.displayName}
                    </div>
                  </td>
                  {isAdmin && (
                    <td style={{textAlign:"center"}}>
                      <button
                        onClick={() => handlePaidClick(entry.userId)}
                        style={{
                          background: paidMap[entry.userId] ? "rgba(45,90,39,0.15)" : "#c0392b",
                          color: paidMap[entry.userId] ? "#2d6a1f" : "#fff",
                          border: paidMap[entry.userId] ? "1px solid rgba(45,90,39,0.35)" : "none",
                          borderRadius:"3px", padding:"2px 10px",
                          fontFamily:"'EB Garamond',serif", fontSize:"0.78rem",
                          cursor:"pointer", fontWeight:600, whiteSpace:"nowrap",
                        }}
                      >
                        {paidMap[entry.userId] ? "✓ Paid" : "Unpaid"}
                      </button>
                    </td>
                  )}
                  {Array.from({length:5}).map((_,pi) => {
                    const pk = entry.picksWithScores[pi];
                    const pkTier = pk ? getPickTier(pk) : null;
                    return (
                      <td key={pi} style={{fontSize:"0.82rem", verticalAlign:"middle"}}>
                        {pk ? (
                          <div>
                            <div style={{display:"flex", alignItems:"center", gap:"4px", marginBottom:"2px"}}>
                              {pkTier && <TierBadge tier={pkTier} compact />}
                              <span style={{fontFamily:"'Crimson Text',serif", color:"var(--text-dark)"}}>{pk.name}</span>
                            </div>
                            <div className={sc(pk.adjusted)} style={{fontSize:"0.75rem", fontFamily:"'EB Garamond',serif"}}>
                              {pk.display}
                            </div>
                          </div>
                        ) : (
                          <span style={{color:"var(--text-light)", fontSize:"0.75rem"}}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td style={{textAlign:"center"}}>
                    <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", color: entry.tierSum >= TIER_MIN_SUM ? "#90d090" : "#e08060", fontWeight:600}}>
                      {entry.tierSum}
                    </span>
                  </td>
                  <td style={{textAlign:"center", fontSize:"0.72rem", color:"var(--text-light)", fontFamily:"'EB Garamond',serif", whiteSpace:"nowrap"}}>
                    {formatSavedAt(entry.savedAt) || "—"}
                  </td>
                  <td className={sc(entry.total)} style={{textAlign:"right", fontWeight:700, fontFamily:"'EB Garamond',serif", fontSize:"1rem"}}>
                    {players.length > 0 ? formatScore(entry.total) : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {players.length === 0 && (
        <div style={{padding:"0.8rem 1.4rem", fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)"}}>
          Scores will appear once the tournament begins.
        </div>
      )}
    </div>
  );
}

// ─── Summary View (pick trends + prize breakdown) ─────────────────────────────
function SummaryView({ entries, displayPlayers, tournamentOdds, tierOverrides, rankMap, isAdmin, prizeRevealed, prizePositions, potOverride, extraPaidCount = 0 }) {
  const oddsActive = Object.keys(tournamentOdds).length > 0;

  // Count how many times each golfer was picked, and determine their tier
  const pickCounts = {};
  const playerTierMap = {};
  entries.forEach(entry => {
    (entry.picks || []).forEach(pk => {
      if (!pickCounts[pk.id]) pickCounts[pk.id] = { id: pk.id, name: pk.name, count: 0 };
      pickCounts[pk.id].count++;
      if (playerTierMap[pk.id] === undefined) {
        if (tierOverrides[pk.id] !== undefined) {
          playerTierMap[pk.id] = tierOverrides[pk.id];
        } else {
          const oddsPos = oddsActive ? (tournamentOdds[normName(pk.name)] ?? null) : null;
          playerTierMap[pk.id] = oddsPos !== null ? getTierForOddsPosition(oddsPos) : getTierForRank(rankMap[pk.id] || null);
        }
      }
    });
  });

  // Group by tier, sort each by count desc
  const byTier = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  Object.values(pickCounts).forEach(p => {
    const tier = playerTierMap[p.id] || 3;
    if (byTier[tier]) byTier[tier].push(p);
  });
  Object.values(byTier).forEach(arr => arr.sort((a, b) => b.count - a.count));

  // Prize breakdown
  let prizeDisplay = null;
  if (isAdmin || prizeRevealed) {
    const entryCount = entries.length + extraPaidCount;
    if (entryCount > 0) {
      const pot = potOverride !== null ? potOverride : entryCount * ENTRY_FEE;
      const computeAmounts = n => {
        const s = computePrizeSplits(n);
        return s.map((pct, i) => {
          if (i < s.length - 1) return Math.round(pot * pct / 100);
          const prev = s.slice(0, -1).reduce((sum, p) => sum + Math.round(pot * p / 100), 0);
          return pot - prev;
        });
      };
      let maxPos = 1;
      for (let n = 1; n <= MAX_PRIZE_POSITIONS; n++) {
        const a = computeAmounts(n);
        if (a[a.length - 1] >= MIN_BOTTOM_PRIZE) maxPos = n; else break;
      }
      const pos = Math.min(prizePositions ?? defaultPrizePositions(entryCount), maxPos);
      const amounts = computeAmounts(pos);
      const ordinals = ["1st","2nd","3rd","4th","5th","6th","7th","8th","9th","10th"];
      prizeDisplay = { pos, amounts, ordinals };
    }
  }

  return (
    <div style={{display:"flex", flexDirection:"column", gap:"1.5rem"}}>
      {/* Pick trends per tier */}
      <div className="section-card">
        <div className="s-head">
          <div>
            <div className="s-head-title">Pick Summary</div>
            <div className="s-head-sub">Top 3 most chosen golfers per tier · {entries.length} entr{entries.length !== 1 ? "ies" : "y"}</div>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="empty" style={{padding:"2rem"}}>No entries yet — summary will appear once participants save their teams.</div>
        ) : (
          <div style={{padding:"1rem 1.4rem", display:"flex", flexDirection:"column", gap:"1.4rem"}}>
            {[1,2,3,4,5].map(tier => {
              const picks = byTier[tier].slice(0, 3);
              const info = getTierInfo(tier);
              if (picks.length === 0) return null;
              return (
                <div key={tier}>
                  <div style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"8px"}}>
                    <TierBadge tier={tier} />
                    <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", letterSpacing:"0.06em"}}>
                      {info.label} · Rank {info.min}{info.max < 9999 ? `–${info.max}` : "+"}
                    </span>
                  </div>
                  <div style={{display:"flex", flexDirection:"column", gap:"5px"}}>
                    {picks.map((p, i) => {
                      const pct = entries.length > 0 ? Math.round(p.count / entries.length * 100) : 0;
                      const medals = ["1st","2nd","3rd"];
                      return (
                        <div key={p.id} style={{display:"flex", alignItems:"center", gap:"10px"}}>
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", width:"26px", flexShrink:0, color: i===0?"var(--gold)":"var(--text-light)"}}>{medals[i]}</span>
                          <div style={{flex:1, height:"6px", background:"rgba(201,168,76,0.12)", borderRadius:"3px", overflow:"hidden", minWidth:"40px"}}>
                            <div style={{width:`${pct}%`, height:"100%", background: i === 0 ? "var(--gold)" : "rgba(201,168,76,0.45)", borderRadius:"3px", transition:"width 0.3s"}} />
                          </div>
                          <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.9rem", color:"var(--text-dark)", minWidth:"130px"}}>{p.name}</span>
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", color:"var(--text-light)", whiteSpace:"nowrap"}}>{p.count} pick{p.count !== 1 ? "s" : ""} ({pct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Prize breakdown */}
      {prizeDisplay && (
        <div className="section-card">
          <div className="s-head">
            <div>
              <div className="s-head-title">Prize Breakdown</div>
              <div className="s-head-sub">{prizeDisplay.pos} paid position{prizeDisplay.pos !== 1 ? "s" : ""}</div>
            </div>
          </div>
          <div style={{padding:"1rem 1.4rem", display:"flex", flexDirection:"column", gap:"7px"}}>
            {prizeDisplay.amounts.map((amt, i) => (
              <div key={i} style={{display:"flex", alignItems:"center", gap:"10px"}}>
                <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color: i === 0 ? "var(--gold)" : "#9a8850", width:"30px", textAlign:"right", flexShrink:0}}>{prizeDisplay.ordinals[i]}</div>
                <div style={{flex:1, height:"5px", borderRadius:"3px", background:"rgba(201,168,76,0.1)", overflow:"hidden", minWidth:"40px"}}>
                  <div style={{width:`${prizeDisplay.amounts[i] / prizeDisplay.amounts[0] * 100}%`, height:"100%", background: i === 0 ? "var(--gold)" : "rgba(201,168,76,0.4)", borderRadius:"3px"}} />
                </div>
                <div style={{fontFamily:"'Playfair Display',serif", fontSize:"0.95rem", color: i === 0 ? "var(--gold)" : "#c8a850", width:"52px", textAlign:"right", flexShrink:0}}>€{amt}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TournamentLeaderboard({ players, cutScore, loading, onRefresh, refreshing }) {
  const [search, setSearch] = useState("");
  const sc = n => n<0?"su":n>0?"so":"se";
  const filtered = players.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="section-card">
      <div className="s-head">
        <div>
          <div className="s-head-title">Tournament Leaderboard</div>
          <div className="s-head-sub">All competing golfers · Live from ESPN</div>
        </div>
        <button className="pick-btn" onClick={onRefresh}>{refreshing?"↻…":"↻ Refresh"}</button>
      </div>
      <div className="search-wrap">
        <input className="search-input" placeholder="Search players…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {cutScore !== null && (
        <div className="cut-banner" style={{margin:"0.8rem 1.4rem 0"}}>
          <div className="cut-info">
            Cut line: <strong>{formatScore(cutScore)}</strong>
            <span style={{marginLeft:"14px", fontSize:"0.8rem", opacity:0.8}}>
              MC / WD → {formatScore(cutScore+10)} · Cap → {formatScore(cutScore+9)}
            </span>
          </div>
        </div>
      )}
      {players.length > 0 && (
        <div className="footnote" style={{display:"flex", gap:"1.2rem", flexWrap:"wrap"}}>
          <span><span className="player-dot dot-grey" style={{display:"inline-block"}}></span> Not started</span>
          <span><span className="player-dot dot-green" style={{display:"inline-block"}}></span> Playing</span>
          <span><span className="player-dot dot-blue" style={{display:"inline-block"}}></span> Round complete</span>
          <span><span className="player-dot dot-red" style={{display:"inline-block"}}></span> MC / WD</span>
          {cutScore !== null && <span style={{marginLeft:"auto"}}>* Fantasy adjusted: MC/WD → cut+10 · cap at cut+9</span>}
        </div>
      )}
      {loading
        ? <div className="loading">Loading leaderboard…</div>
        : players.length === 0
          ? <div className="empty">No player data yet.<br/>This tournament may not have started, or ESPN hasn't published scores.</div>
          : (
            <>
              <div className="lb-table-wrap">
              <table className="lb-table">
                <thead>
                  <tr><th className="col-pos" style={{textAlign:"center"}}>#</th><th>Player</th><th className="col-score" style={{textAlign:"right"}}>Actual</th><th style={{textAlign:"center", color:"var(--gold)"}}>Score</th></tr>
                </thead>
                <tbody>
                  {filtered.map(p => (
                    <tr key={p.id} className={(p.cut||p.withdrawn)?"is-cut":""} style={{cursor:"default"}}>
                      <td className="pos-c">{p.position}</td>
                      <td className="name-c">
                        <span className={`player-dot ${p.playStatus==="cut_wd"?"dot-red":p.playStatus==="finished"?"dot-blue":p.playStatus==="not_started"?"dot-grey":"dot-green"}`}></span>
                        {p.name}
                      </td>
                      <td className="col-score" style={{textAlign:"right", fontSize:"0.88rem"}}>
                        {p.cut
                          ? <span style={{color:"#e05050", fontWeight:700, fontSize:"0.75rem", letterSpacing:"0.06em"}}>CUT</span>
                          : p.withdrawn
                            ? <span style={{color:"#e05050", fontWeight:700, fontSize:"0.75rem", letterSpacing:"0.06em"}}>WD</span>
                            : <span className={sc(p.actualScore)}>{formatScore(p.actualScore)}</span>
                        }
                      </td>
                      <td style={{textAlign:"center"}}>
                        {p.scoreCell?.fantasy != null
                          ? <span style={{color: p.scoreCell.penalised?"#e05050":"#5b9bd5", fontWeight:600, fontSize:"0.88rem"}}>{p.scoreCell.fantasy}</span>
                          : (p.cut || p.withdrawn)
                            ? <span style={{color:"#e05050", fontWeight:600, fontSize:"0.88rem"}}>—</span>
                            : <span style={{fontWeight:600, fontSize:"0.88rem"}} className={sc(p.actualScore)}>{formatScore(p.actualScore)}</span>
                        }
                      </td>
                      <td className={sc(p.adjusted)} style={{textAlign:"right"}}>{p.displayScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )
      }
    </div>
  );
}

// ─── Competition Leaderboard ──────────────────────────────────────────────────
function CompetitionPage({ user, isAdmin }) {
  const [events, setEvents]     = useState([]);
  const [selected, setSelected] = useState(null);
  const [rows, setRows]         = useState([]);
  const [prevRows, setPrevRows] = useState([]); // for rank movement arrows
  const [players, setPlayers]   = useState([]);
  const [cutScore, setCutScore] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [revealed, setRevealed]   = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const [showSeason, setShowSeason]   = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [nationalityMap, setNationalityMap] = useState({});
  const [playerNames, setPlayerNames] = useState({});
  const [prizePositions, setPrizePositions] = useState(null);
  const compRefreshRef            = useRef(null);

  useEffect(() => {
    fetchTournaments().then(evs => {
      const sorted = [...evs].sort((a,b) => new Date(a.date) - new Date(b.date));
      setEvents(sorted);
      // Auto-select the live tournament, or failing that the most recent one
      const now = Date.now();
      const live = sorted.find(e => {
        const s = new Date(e.date).getTime();
        const en = e.endDate ? new Date(e.endDate).getTime() + 24*60*60*1000 : s + 4*24*60*60*1000;
        return now >= s && now <= en;
      });
      const recent = [...sorted].reverse().find(e => new Date(e.date).getTime() <= now);
      const pick = live || recent || sorted[0];
      if (pick) setSelected(pick.id);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    (async () => {
      setLoading(true);
      const [allPicks, { players: lp, espnCutScore }, savedCut, revealState, natData, savedPlayerNames, prizePositionsData] = await Promise.all([
        store.get(`allpicks__${selected}`).then(v => v || {}),
        fetchLeaderboard(selected, events.find(e => e.id === selected)?.date),
        store.get(`cut__${selected}`),
        store.get(`reveal__${selected}`),
        store.get("player_nationality"),
        store.get("player_names").then(v => v || {}),
        store.get(`prizepositions__${selected}`),
      ]);
      if (natData) setNationalityMap(natData);
      setPlayerNames(savedPlayerNames);
      const eff = (savedCut?.value ?? savedCut) ?? espnCutScore;
      setPlayers(lp);
      setCutScore(eff);
      setRevealed(!!revealState?.revealed);
      setPrizePositions(prizePositionsData?.positions ?? null);

      const computed = Object.values(allPicks).map(entry => {
        const total = entry.picks.reduce((sum, pk) => {
          const live = lp.find(p => p.id===pk.id);
          if (!live) return sum;
          return sum + applyScoreRules(live, eff).adjusted;
        }, 0);
        return { userId: entry.userId, displayName: savedPlayerNames[entry.userId] || entry.displayName, picks: entry.picks, total };
      });
      computed.sort((a, b) => {
        if (a.total !== b.total) return a.total - b.total;
        return (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase());
      });
      setRows(prev => { setPrevRows(prev); return computed; });
      setLoading(false);
    })();
  }, [selected, refreshTick]);

  // Auto-refresh competition leaderboard every 2 minutes when a live event is selected
  useEffect(() => {
    if (!selected) return;
    const ev = events.find(e => e.id === selected);
    if (!ev) return;
    const start  = new Date(ev.date).getTime();
    const end    = ev.endDate ? new Date(ev.endDate).getTime() + 24*60*60*1000 : start + 4*24*60*60*1000;
    const isLive = Date.now() >= start && Date.now() <= end;
    if (!isLive) return;
    compRefreshRef.current = setInterval(() => {
      setRefreshTick(t => t + 1);
    }, 2 * 60 * 1000);
    return () => clearInterval(compRefreshRef.current);
  }, [selected, events]);

  const sc = n => n<0?"su":n>0?"so":"se";
  const myRow  = rows.find(r => r.userId===user.uid);
  const myRank = rows.findIndex(r => r.userId===user.uid);

  // Compute prize count for this tournament
  const prizeCount = (() => {
    const n = rows.length;
    if (n === 0) return 0;
    const pot = n * ENTRY_FEE;
    let maxPos = 1;
    for (let k = 1; k <= MAX_PRIZE_POSITIONS; k++) {
      const splits = computePrizeSplits(k);
      const lastAmt = pot - splits.slice(0, -1).reduce((s, p) => s + Math.round(pot * p / 100), 0);
      if (lastAmt >= MIN_BOTTOM_PRIZE) maxPos = k; else break;
    }
    return Math.min(prizePositions ?? defaultPrizePositions(n), maxPos);
  })();

  // Compute tied rank for each row (same score → same rank; next unique score skips ahead)
  const tiedRanks = rows.reduce((acc, row, i) => {
    acc.push(i === 0 ? 1 : rows[i - 1].total === row.total ? acc[i - 1] : i + 1);
    return acc;
  }, []);

  return (
    <div>
      <div className="page-title">Competition Leaderboard</div>
      <div className="page-subtitle">Combined team scores across all participants</div>

      <div className="tab-bar" style={{marginBottom:"1.5rem"}}>
        <div className={`tab ${!showArchive && !showSeason?"active":""}`} onClick={() => { setShowArchive(false); setShowSeason(false); }}>Live Leaderboard</div>
        <div className={`tab ${showSeason?"active":""}`} onClick={() => { setShowArchive(false); setShowSeason(true); }}>Season Standings</div>
        <div className={`tab ${showArchive?"active":""}`} onClick={() => { setShowSeason(false); setShowArchive(true); }}>Past Results</div>
      </div>

      {showArchive ? <HistoricalArchive /> : showSeason ? <SeasonStandings user={user} /> : <>

      <div style={{marginBottom:"1.5rem"}}>
        <label style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", display:"block", marginBottom:"6px"}}>Tournament</label>
        <select
          style={{padding:"0.6rem 0.9rem", border:"1px solid var(--cream-dark)", borderRadius:"2px", fontFamily:"'Crimson Text',serif", fontSize:"0.95rem", background:"var(--white)", color:"var(--text-dark)", outline:"none", cursor:"pointer"}}
          value={selected||""} onChange={e => setSelected(e.target.value)}
        >
          {events.map(ev => <option key={ev.id} value={ev.id}>{ev.name}{isMajor(ev.name)?" (Major)":""}</option>)}
        </select>
      </div>

      {cutScore !== null && (
        <div className="cut-banner" style={{marginBottom:"1.5rem"}}>
          <div className="cut-info">
            Cut line: <strong>{formatScore(cutScore)}</strong>
            <span style={{marginLeft:"14px", fontSize:"0.8rem", opacity:0.8}}>
              MC / WD → {formatScore(cutScore+10)} &nbsp;·&nbsp; Cap → {formatScore(cutScore+9)}
            </span>
          </div>
        </div>
      )}


      {loading
        ? <div className="loading">Loading scores…</div>
        : rows.length===0
          ? <div className="info-banner">No teams saved for this tournament yet. Head to the Tournaments tab, pick your 5 players and save your team!</div>
          : (
            <>
              {/* Nationality Battle */}
              {(() => {
                const NAT_GROUPS = ["Ireland", "Catalonia", "England"];
                const groups = NAT_GROUPS
                  .map(nat => {
                    const members = rows.filter(r => nationalityMap[r.userId] === nat);
                    if (members.length === 0) return null;
                    const avg = members.reduce((s,r) => s+r.total, 0) / members.length;
                    return { nat, members, avg };
                  })
                  .filter(Boolean)
                  .sort((a,b) => a.avg - b.avg);
                if (groups.length === 0) return null;
                const fmtAvg = v => {
                  const rounded = Math.round(v * 10) / 10;
                  return rounded > 0 ? `+${rounded}` : rounded === 0 ? "E" : `${rounded}`;
                };
                return (
                  <div style={{marginBottom:"1.5rem"}}>
                    <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", letterSpacing:"0.12em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"0.6rem"}}>
                      Nationality Battle
                    </div>
                    <div style={{background:"var(--white)", border:"1px solid var(--cream-dark)", borderRadius:"4px", overflow:"hidden", boxShadow:"0 2px 8px rgba(26,46,26,0.07)"}}>
                      {groups.map((g, i) => (
                        <div key={g.nat} style={{
                          display:"grid", gridTemplateColumns:"36px 1fr auto",
                          alignItems:"center", padding:"0.65rem 1.2rem",
                          borderBottom: i < groups.length-1 ? "1px solid var(--cream-dark)" : "none",
                          background: i===0 ? "rgba(201,168,76,0.07)" : "var(--white)",
                        }}>
                          <div style={{fontFamily:"'Playfair Display',serif", color:"var(--gold)", fontWeight:700, fontSize:"1.1rem"}}>
                            {`#${i+1}`}
                          </div>
                          <div style={{display:"flex", alignItems:"center", gap:"8px"}}>
                            <NatFlag nationality={g.nat} size={20} />
                            <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.95rem", fontWeight:600}}>{g.nat}</span>
                            <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.75rem", color:"var(--text-light)"}}>
                              ({g.members.length} {g.members.length===1?"entry":"entries"})
                            </span>
                          </div>
                          <div style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", fontWeight:700, color: g.avg<0?"#6fba58":g.avg>0?"#e08080":"var(--gold)"}}>
                            {fmtAvg(g.avg)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div className="comp-lb">
                <div className="c-row hdr"><span>Rank</span><span>Participant</span><span>Score</span></div>

                {rows.map((row,i) => {
                    const prevIdx = prevRows.findIndex(p => p.userId === row.userId);
                    const moved = prevRows.length > 0 && prevIdx !== -1 ? prevIdx - i : 0;
                    const arrow = moved > 0 ? <span style={{color:"#4caf50", fontSize:"0.72rem"}}>▲{moved}</span>
                                 : moved < 0 ? <span style={{color:"#e05050", fontSize:"0.72rem"}}>▼{Math.abs(moved)}</span>
                                 : prevRows.length > 0 ? <span style={{color:"var(--text-light)", fontSize:"0.68rem"}}>–</span>
                                 : null;
                    return (
                    <div key={row.userId} className={`c-row ${row.userId===user.uid?"me":""}`}>
                      <div className="c-rank">{tiedRanks[i] <= prizeCount ? `#${tiedRanks[i]}` : ""}{arrow}</div>
                      <div className="c-user">
                        {nationalityMap[row.userId] && <span style={{marginRight:"6px"}}><NatFlag nationality={nationalityMap[row.userId]} /></span>}
                        {row.displayName}
                        {row.userId===user.uid && <span style={{fontSize:"0.66rem", color:"var(--gold)", marginLeft:"6px", fontFamily:"'EB Garamond',serif", letterSpacing:"0.06em"}}>YOU</span>}
                        <small style={{display:"flex", flexWrap:"wrap", columnGap:"10px", rowGap:"2px", marginTop:"3px"}}>
                          {row.picks.map(pk => {
                            const live = players.find(p=>p.id===pk.id);
                            const rs=applyScoreRules(live,cutScore); const sc2=formatScoreCell(rs.actualScore,rs.fantasyScore,rs.penalised);
                            const dotClass = !live ? "dot-grey" : (live.withdrawn||rs.penalised) ? "dot-red" : live.playStatus==="finished"?"dot-blue":live.playStatus==="not_started"||live.playStatus==="cut_wd"?"dot-grey":"dot-green";
                            return (
                              <span key={pk.id} style={{display:"inline-flex", alignItems:"center", whiteSpace:"nowrap"}}>
                                <span className={`player-dot ${dotClass}`}></span>
                                {pk.name} ({sc2.fantasy??formatScore(rs.actualScore)})
                              </span>
                            );
                          })}
                        </small>
                      </div>
                      <div className={`c-score ${sc(row.total)}`}>{formatScore(row.total)}</div>
                    </div>
                    );
                  })}
              </div>
            </>
          )
      }
      </> /* end live leaderboard */}
    </div>
  );
}

// ─── Players Directory ────────────────────────────────────────────────────────
function PlayersDirectory() {
  const [stats, setStats]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [year, setYear]           = useState(null);
  const [years, setYears]         = useState([]);
  const [playerPhotos, setPlayerPhotos] = useState({});
  const [playerNationalities, setPlayerNationalities] = useState({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      const evs = await fetchTournaments();
      const now = Date.now();
      const past = evs.filter(e => {
        const end = e.endDate ? new Date(e.endDate).getTime() + 24*60*60*1000 : new Date(e.date).getTime() + 4*24*60*60*1000;
        return end < now;
      }).sort((a, b) => new Date(a.date) - new Date(b.date));

      const [playerNames, playerPhotos, natData] = await Promise.all([
        store.get("player_names").then(v => v || {}),
        store.get("player_photos").then(v => v || {}),
        store.get("player_nationality"),
      ]);
      if (natData) setPlayerNationalities(natData);
      const yearSet = new Set();
      const statMap = {};

      await Promise.all(past.map(async ev => {
        const yr = new Date(ev.date).getFullYear();
        const [allPicksRaw, { players: lp, espnCutScore }, savedCut, revealState] = await Promise.all([
          store.get(`allpicks__${ev.id}`).then(v => v || {}),
          fetchLeaderboard(ev.id, ev.date),
          store.get(`cut__${ev.id}`),
          store.get(`reveal__${ev.id}`),
        ]);
        if (!revealState?.revealed) return;
        const eff = (savedCut?.value ?? savedCut) ?? espnCutScore;
        const entries = Object.values(allPicksRaw);
        if (entries.length === 0) return;

        const scored = entries.map(entry => ({
          uid:         entry.userId,
          displayName: playerNames[entry.userId] || entry.displayName,
          total:       entry.picks.reduce((sum, pk) => {
            const live = lp.find(p => p.id === pk.id);
            return live ? sum + applyScoreRules(live, eff).adjusted : sum;
          }, 0),
        })).sort((a, b) => a.total - b.total);

        yearSet.add(yr);
        scored.forEach((s, i) => {
          if (!statMap[s.uid]) statMap[s.uid] = { displayName: s.displayName, results: [] };
          statMap[s.uid].results.push({
            tourneyId: ev.id, tourneyName: ev.name, date: ev.date,
            year: yr, position: i + 1, outOf: scored.length,
          });
        });
      }));

      const allYears = [...yearSet].sort((a, b) => b - a);
      const defaultYear = allYears[0] || new Date().getFullYear();
      setYears(allYears);
      setYear(defaultYear);

      // Sort by overall best finish, then name
      const sorted = Object.entries(statMap)
        .map(([uid, v]) => ({ uid, ...v }))
        .sort((a, b) => {
          const bestA = a.results.length ? Math.min(...a.results.map(r => r.position)) : 999;
          const bestB = b.results.length ? Math.min(...b.results.map(r => r.position)) : 999;
          if (bestA !== bestB) return bestA - bestB;
          return a.displayName.localeCompare(b.displayName);
        });

      setPlayerPhotos(playerPhotos);
      setStats(sorted);
      setLoading(false);
    })();
  }, []);

  const posLabel = pos => `#${pos}`;
  const shortTourney = name => {
    if (/masters/i.test(name))       return "Masters";
    if (/u\.?s\.?\s*open/i.test(name)) return "US Open";
    if (/the open/i.test(name))      return "The Open";
    if (/pga champ/i.test(name))     return "PGA Champ.";
    return name.split(" ").slice(0, 2).join(" ");
  };

  if (loading) return <div className="loading">Loading player results…</div>;
  if (stats.length === 0) return <div className="empty">No players have signed up yet.</div>;

  return (
    <div>
      {/* Year selector */}
      <div style={{display:"flex", alignItems:"center", gap:"0.75rem", marginBottom:"1.5rem", flexWrap:"wrap"}}>
        <label style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)"}}>Year</label>
        <div style={{display:"flex", gap:"6px"}}>
          {years.map(y => (
            <button key={y}
              className={`tab${year === y ? " active" : ""}`}
              style={{padding:"4px 14px", fontSize:"0.82rem"}}
              onClick={() => setYear(y)}
            >{y}</button>
          ))}
          {years.length === 0 && <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", color:"var(--text-light)"}}>{new Date().getFullYear()}</span>}
        </div>
      </div>

      <div style={{display:"flex", flexDirection:"column", gap:"0.6rem"}}>
        {stats.map(player => {
          const yearResults = player.results.filter(r => r.year === year);
          const allBest = player.results.length ? Math.min(...player.results.map(r => r.position)) : null;
          const photo = playerPhotos[player.uid] || null;
          const initials = (player.displayName || "?")[0].toUpperCase();

          return (
            <div key={player.uid} style={{
              background:"var(--white)", border:"1px solid var(--cream-dark)",
              borderRadius:"4px", padding:"0.75rem 1.1rem",
              display:"grid", gridTemplateColumns:"46px 220px 1fr",
              alignItems:"center", gap:"0 0.9rem",
            }}>
              {/* Avatar */}
              {photo
                ? <img src={photo} alt="" style={{width:"38px", height:"38px", borderRadius:"50%", objectFit:"cover", border:"2px solid var(--cream-dark)"}} />
                : <div style={{width:"38px", height:"38px", borderRadius:"50%", background:"var(--green-mid)", border:"2px solid var(--cream-dark)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.95rem", color:"var(--cream)", fontWeight:700, fontFamily:"'Playfair Display',serif"}}>
                    {initials}
                  </div>
              }

              {/* Name + overall best finish — fixed 220px column */}
              <div style={{display:"flex", alignItems:"center", gap:"0.5rem", overflow:"hidden"}}>
                {playerNationalities[player.uid] && <span style={{flexShrink:0, marginRight:"4px"}}><NatFlag nationality={playerNationalities[player.uid]} /></span>}
                <span style={{fontFamily:"'Crimson Text',serif", fontWeight:600, fontSize:"1rem", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{player.displayName}</span>
                {allBest && (
                  <span title="Overall best finish" style={{
                    fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", flexShrink:0,
                    background:"rgba(201,168,76,0.12)", border:"1px solid rgba(201,168,76,0.35)",
                    color:"var(--gold)", borderRadius:"3px", padding:"1px 6px",
                  }}>
                    {posLabel(allBest)}
                  </span>
                )}
              </div>

              {/* This year's results — always starts at same column */}
              <div style={{display:"flex", gap:"5px", flexWrap:"wrap", alignItems:"center"}}>
                {yearResults.length === 0
                  ? <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"var(--text-light)", fontStyle:"italic"}}>No entries in {year}</span>
                  : yearResults.map(r => (
                    <span key={r.tourneyId}
                      title={shortTourney(r.tourneyName)}
                      style={{
                        display:"inline-flex", flexDirection:"column", alignItems:"center",
                        background: r.position === 1 ? "rgba(201,168,76,0.12)" : "rgba(45,90,39,0.07)",
                        border: `1px solid ${r.position === 1 ? "rgba(201,168,76,0.35)" : "rgba(45,90,39,0.2)"}`,
                        borderRadius:"3px", padding:"2px 8px", cursor:"default",
                      }}
                    >
                      <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.9rem", fontWeight:600}}>
                        {posLabel(r.position)}
                      </span>
                      <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.64rem", color:"var(--text-light)", lineHeight:1.2}}>
                        {shortTourney(r.tourneyName)}
                      </span>
                    </span>
                  ))
                }
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Season Standings ────────────────────────────────────────────────────────
function SeasonStandings({ user }) {
  const [rows, setRows]           = useState([]);
  const [majors, setMajors]       = useState([]); // ordered list of major meta
  const [loading, setLoading]     = useState(true);
  const [nationalityMap, setNationalityMap] = useState({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      const evs = await fetchTournaments();
      const majorEvs = evs
        .filter(e => isMajor(e.name))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const now = Date.now();
      const [playerNames, natData] = await Promise.all([
        store.get("player_names").then(v => v || {}),
        store.get("player_nationality"),
      ]);
      if (natData) setNationalityMap(natData);

      const statMap = {}; // uid -> { displayName, totalPoints, breakdown: { [tournamentId]: { position, outOf, points, status } } }

      const majorMeta = await Promise.all(majorEvs.map(async ev => {
        const start   = new Date(ev.date).getTime();
        const end     = ev.endDate ? new Date(ev.endDate).getTime() + 24*60*60*1000 : start + 4*24*60*60*1000;
        const isComplete = end < now;
        const isLive     = now >= start && now <= end;
        const status     = isComplete ? "complete" : isLive ? "live" : "upcoming";

        if (status === "upcoming") return { id: ev.id, name: ev.name, status, entrants: 0 };

        const [allPicksRaw, { players: lp, espnCutScore }, savedCut] = await Promise.all([
          store.get(`allpicks__${ev.id}`).then(v => v || {}),
          fetchLeaderboard(ev.id, ev.date),
          store.get(`cut__${ev.id}`),
        ]);
        const eff     = (savedCut?.value ?? savedCut) ?? espnCutScore;
        const entries = Object.values(allPicksRaw);
        if (entries.length === 0) return { id: ev.id, name: ev.name, status, entrants: 0 };

        const scored = entries.map(entry => ({
          uid:         entry.userId,
          displayName: playerNames[entry.userId] || entry.displayName,
          total:       entry.picks.reduce((sum, pk) => {
            const live = lp.find(p => p.id === pk.id);
            return live ? sum + applyScoreRules(live, eff).adjusted : sum;
          }, 0),
        })).sort((a, b) => a.total - b.total);

        const n = scored.length;
        scored.forEach(s => {
          const beaten   = scored.filter(o => o.total > s.total).length;
          const position = scored.filter(o => o.total < s.total).length + 1;
          const pts      = n === 1 ? 100 : (beaten / (n - 1)) * 100;
          if (!statMap[s.uid]) statMap[s.uid] = { displayName: s.displayName, totalPoints: 0, breakdown: {} };
          statMap[s.uid].totalPoints       += pts;
          statMap[s.uid].breakdown[ev.id]   = { position, outOf: n, points: pts, status };
        });

        return { id: ev.id, name: ev.name, status, entrants: n };
      }));

      const sorted = Object.entries(statMap)
        .map(([uid, v]) => ({ uid, ...v }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

      setRows(sorted);
      setMajors(majorMeta);
      setLoading(false);
    })();
  }, []);

  const completedMajors = majors.filter(m => m.status !== "upcoming");
  const maxPoints       = majors.length * 100;

  const posLabel = pos => {
    const mod100 = pos % 100;
    const mod10  = pos % 10;
    if (mod100 >= 11 && mod100 <= 13) return `${pos}th`;
    if (mod10 === 1) return `${pos}st`;
    if (mod10 === 2) return `${pos}nd`;
    if (mod10 === 3) return `${pos}rd`;
    return `${pos}th`;
  };
  const shortName = name => {
    if (/masters/i.test(name))  return "Masters";
    if (/u\.?s\.?\s*open/i.test(name)) return "US Open";
    if (/the open/i.test(name)) return "The Open";
    if (/pga champ/i.test(name)) return "PGA Champ.";
    return name.split(" ").slice(0,2).join(" ");
  };

  return (
    <div>
      {/* Scoring explainer */}
      <div style={{background:"var(--cream)", border:"1px solid var(--cream-dark)", borderRadius:"4px", padding:"0.8rem 1.2rem", marginBottom:"1.5rem", fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", color:"var(--text-mid)", lineHeight:1.5}}>
        <strong style={{color:"var(--text-dark)"}}>How points are calculated:</strong> For each major you enter, you earn points based on how much of the field you beat.
        The winner earns <strong>100 pts</strong>, last place earns <strong>0 pts</strong>, and everyone else scales in between.
        Not entering a major scores <strong>0 pts</strong>. Maximum possible: <strong>{maxPoints} pts</strong> across {majors.length} major{majors.length !== 1 ? "s" : ""}.
      </div>

      {loading ? <div className="loading">Computing season standings…</div> : rows.length === 0 ? (
        <div className="empty">No entries found for any major yet.</div>
      ) : (
        <>
          {/* Major column headers */}
          <div style={{overflowX:"auto"}}>
            <table className="lb-table" style={{minWidth:"500px"}}>
              <thead>
                <tr>
                  <th style={{width:"44px"}}>Rank</th>
                  <th>Player</th>
                  {majors.map(m => (
                    <th key={m.id} style={{textAlign:"center", whiteSpace:"nowrap"}}>
                      {shortName(m.name)}
                      {m.status === "live" && <span style={{display:"block", fontSize:"0.6rem", color:"#4caf50", letterSpacing:"0.06em"}}>LIVE</span>}
                      {m.status === "upcoming" && <span style={{display:"block", fontSize:"0.6rem", color:"var(--text-light)", letterSpacing:"0.06em"}}>UPCOMING</span>}
                    </th>
                  ))}
                  <th style={{textAlign:"right", color:"var(--gold)"}}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const isMe = row.uid === user.uid;
                  return (
                    <tr key={row.uid} style={{background: isMe ? "rgba(45,90,39,0.06)" : undefined}}>
                      <td className="pos-c" style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem"}}>
                        {`#${i+1}`}
                      </td>
                      <td className="name-c">
                        {nationalityMap[row.uid] && <span style={{marginRight:"6px"}}><NatFlag nationality={nationalityMap[row.uid]} /></span>}
                        {row.displayName}
                        {isMe && <span style={{fontSize:"0.66rem", color:"var(--gold)", marginLeft:"6px", fontFamily:"'EB Garamond',serif", letterSpacing:"0.06em"}}>YOU</span>}
                      </td>
                      {majors.map(m => {
                        const b = row.breakdown[m.id];
                        if (!b) return (
                          <td key={m.id} style={{textAlign:"center", color:"var(--text-light)", fontFamily:"'EB Garamond',serif", fontSize:"0.8rem"}}>
                            {m.status === "upcoming" ? "–" : "DNS"}
                          </td>
                        );
                        return (
                          <td key={m.id} style={{textAlign:"center"}}>
                            <span title={`${posLabel(b.position)} of ${b.outOf} · ${b.points.toFixed(1)} pts`} style={{
                              display:"inline-flex", flexDirection:"column", alignItems:"center", gap:"1px",
                              cursor:"default",
                            }}>
                              <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.9rem", fontWeight:600, color:"var(--text-dark)"}}>
                                {posLabel(b.position)}
                              </span>
                              <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.68rem", color:"var(--text-light)"}}>
                                {b.points.toFixed(1)}pts
                              </span>
                            </span>
                          </td>
                        );
                      })}
                      <td style={{textAlign:"right", fontFamily:"'Playfair Display',serif", fontSize:"1rem", color:"var(--gold)", fontWeight:600}}>
                        {row.totalPoints.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {majors.some(m => m.status === "live") && (
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"var(--text-light)", marginTop:"0.8rem", textAlign:"center"}}>
              Live tournament scores update every 2 minutes — standings may shift until play concludes.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── My Results Page ──────────────────────────────────────────────────────────
function MyResultsPage({ user }) {
  const [events, setEvents]   = useState([]);
  const [results, setResults] = useState([]); // [{tournament, myPicks, myTotal, myRank, totalEntrants, revealed}]
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const evs = await fetchTournaments();
      const sorted = [...evs].sort((a,b) => new Date(b.date) - new Date(a.date)); // newest first
      setEvents(sorted);

      // Load picks + leaderboard data for all past + current events
      const now = Date.now();
      const relevant = sorted.filter(e => new Date(e.date).getTime() <= now);

      const loaded = await Promise.all(relevant.map(async ev => {
        const [myPicksRaw, allPicksRaw, savedCut, revealState] = await Promise.all([
          store.get(`picks__${user.uid}__${ev.id}`),
          store.get(`allpicks__${ev.id}`).then(v => v || {}),
          store.get(`cut__${ev.id}`),
          store.get(`reveal__${ev.id}`),
        ]);
        if (!myPicksRaw || myPicksRaw.length === 0) return null;

        const { players: lp, espnCutScore } = await fetchLeaderboard(ev.id, ev.date);
        const eff = (savedCut?.value ?? savedCut) ?? espnCutScore;

        const myTotal = myPicksRaw.reduce((sum, pk) => {
          const live = lp.find(p => p.id === pk.id);
          if (!live) return sum;
          return sum + applyScoreRules(live, eff).adjusted;
        }, 0);

        const myPicksWithScores = myPicksRaw.map(pk => {
          const live = lp.find(p => p.id === pk.id);
          if (!live) return { ...pk, display: "–" };
          const { actualScore, fantasyScore, penalised } = applyScoreRules(live, eff);
          const cell = formatScoreCell(actualScore, fantasyScore, penalised);
          return { ...pk, display: cell.fantasy ?? formatScore(actualScore), penalised };
        });

        // Calculate rank among all entries
        const allEntries = Object.values(allPicksRaw);
        const allTotals = allEntries.map(entry => ({
          uid: entry.userId,
          total: entry.picks.reduce((sum, pk) => {
            const live = lp.find(p => p.id === pk.id);
            if (!live) return sum;
            return sum + applyScoreRules(live, eff).adjusted;
          }, 0),
        })).sort((a,b) => a.total - b.total);

        const myRank = allTotals.findIndex(e => e.uid === user.uid) + 1;

        return {
          tournament: ev,
          myPicks: myPicksWithScores,
          myTotal,
          myRank,
          totalEntrants: allEntries.length,
          revealed: !!revealState?.revealed,
          cutScore: eff,
          hasScores: lp.length > 0,
        };
      }));

      setResults(loaded.filter(Boolean));
      setLoading(false);
    })();
  }, [user.uid]);

  const sc = n => n < 0 ? "su" : n > 0 ? "so" : "se";

  return (
    <div>
      <div className="page-title">My Results</div>
      <div className="page-subtitle">Your picks and finishing positions across all tournaments</div>

      {loading ? (
        <div className="loading">Loading your history…</div>
      ) : results.length === 0 ? (
        <div className="info-banner">You haven't entered any tournaments yet. Head to Tournaments to make your picks!</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {results.map(r => (
            <div key={r.tournament.id} className="section-card">
              <div className="s-head">
                <div>
                  <div className="s-head-title">
                    {r.tournament.name}
                    {isMajor(r.tournament.name) && <span style={{ marginLeft: "8px", fontSize: "0.7rem", background: "var(--gold)", color: "var(--green-deep)", padding: "1px 6px", borderRadius: "2px", fontFamily: "'EB Garamond',serif", fontWeight: 700 }}>Major</span>}
                  </div>
                  <div className="s-head-sub">
                    {new Date(r.tournament.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {r.revealed || r.myRank > 0 ? (
                    <>
                      <div style={{ fontFamily: "'Playfair Display',serif", fontSize: "1.4rem", color: "var(--gold)", lineHeight: 1 }}>
                        {`#${r.myRank}`}
                      </div>
                      <div style={{ fontFamily: "'EB Garamond',serif", fontSize: "0.72rem", color: "var(--green-pale)", marginTop: "2px" }}>
                        of {r.totalEntrants}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontFamily: "'EB Garamond',serif", fontSize: "0.78rem", color: "var(--text-light)" }}>Pending</div>
                  )}
                </div>
              </div>
              <div style={{ padding: "1rem 1.2rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.8rem" }}>
                  <span style={{ fontFamily: "'EB Garamond',serif", fontSize: "0.76rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-light)" }}>
                    My Team
                  </span>
                  <span style={{ fontFamily: "'Playfair Display',serif", fontSize: "1.1rem" }} className={sc(r.myTotal)}>
                    {r.hasScores ? formatScore(r.myTotal) : "–"}
                    {r.hasScores && <Tip text="Your combined fantasy score. Red scores are penalised (MC/WD). Lower is better." />}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {r.myPicks.map((pk, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "var(--cream)", borderRadius: "2px" }}>
                      <span style={{ fontFamily: "'Crimson Text',serif", fontSize: "0.9rem" }}>{pk.name}</span>
                      <span style={{ fontFamily: "'EB Garamond',serif", fontSize: "0.82rem", color: pk.penalised ? "#e05050" : "var(--text-mid)", fontWeight: pk.penalised ? 600 : 400 }}>
                        {r.hasScores ? pk.display : "–"}
                      </span>
                    </div>
                  ))}
                </div>
                {!r.hasScores && (
                  <div style={{ marginTop: "0.6rem", fontFamily: "'EB Garamond',serif", fontSize: "0.78rem", color: "var(--text-light)", fontStyle: "italic" }}>
                    Scores will appear once the tournament begins
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tier Review View (Admin) ─────────────────────────────────────────────────
function TierReviewView({ players, tierOverrides, onOverride, loading }) {
  const [search, setSearch] = useState("");

  const filtered = players.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="loading">Loading player field…</div>;
  if (players.length === 0) return (
    <div className="section-card">
      <div className="s-head"><div className="s-head-title">Tier Review</div></div>
      <div className="empty" style={{padding:"2rem"}}>
        No players loaded yet. This tournament may not have started — tiers will be available once the field is confirmed on ESPN.
      </div>
    </div>
  );

  const overrideCount = Object.keys(tierOverrides).length;

  return (
    <div className="section-card">
      <div className="s-head">
        <div>
          <div className="s-head-title">Tier Review & Override</div>
          <div className="s-head-sub">
            {players.length} players in field · {overrideCount > 0 ? `${overrideCount} tier override${overrideCount > 1 ? "s" : ""} active` : "No overrides — using betting odds (world rankings as fallback)"}
          </div>
        </div>
      </div>
      <div style={{padding:"0.6rem 1rem", background:"var(--cream)", borderBottom:"1px solid var(--cream-dark)", display:"flex", gap:"0.6rem", flexWrap:"wrap"}}>
        {TIER_BANDS.map(b => (
          <span key={b.tier} style={{display:"flex", alignItems:"center", gap:"4px", fontFamily:"'EB Garamond',serif", fontSize:"0.72rem", color:"var(--text-light)"}}>
            <span style={{background:b.bg, color:b.color, border:`1px solid ${b.color}44`, borderRadius:"2px", fontWeight:700, padding:"1px 5px", fontSize:"0.68rem"}}>T{b.tier}</span>
            Rank {b.min}{b.max < 9999 ? `–${b.max}` : "+"}
          </span>
        ))}
      </div>
      <div className="search-wrap">
        <input className="search-input" placeholder="Search players…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="lb-table-wrap">
        <table className="lb-table">
          <thead>
            <tr>
              <th>Player</th>
              <th style={{textAlign:"center"}}>World Rank</th>
              <th style={{textAlign:"center"}}>Base Tier</th>
              <th style={{textAlign:"center"}}>Override</th>
              <th style={{textAlign:"center"}}>Active Tier</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const isOverridden = tierOverrides[p.id] !== undefined;
              return (
                <tr key={p.id} style={{background: isOverridden ? "rgba(201,168,76,0.06)" : ""}}>
                  <td className="name-c">
                    {p.name}
                    {isOverridden && <span style={{marginLeft:"6px", fontSize:"0.65rem", color:"var(--gold)", fontFamily:"'EB Garamond',serif"}}>overridden</span>}
                  </td>
                  <td style={{textAlign:"center", color:"var(--text-light)", fontSize:"0.82rem", fontFamily:"'EB Garamond',serif"}}>
                    {p.rank ? `#${p.rank}` : "Unranked"}
                  </td>
                  <td style={{textAlign:"center"}}>
                    <TierBadge tier={p.baseTier} />
                  </td>
                  <td style={{textAlign:"center"}}>
                    <select
                      value={tierOverrides[p.id] ?? ""}
                      onChange={e => onOverride(p.id, e.target.value ? Number(e.target.value) : null)}
                      style={{padding:"2px 6px", border:"1px solid var(--cream-dark)", borderRadius:"2px", fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", background:"var(--white)", color:"var(--text-dark)", cursor:"pointer"}}
                    >
                      <option value="">— Auto —</option>
                      {[1,2,3,4,5].map(t => (
                        <option key={t} value={t}>Tier {t}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{textAlign:"center"}}>
                    <TierBadge tier={p.tier} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Profile Page ─────────────────────────────────────────────────────────────
function ProfilePage({ user, onPhotoSaved }) {
  const [uploading, setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal]       = useState(user.displayName || "");
  const [savingName, setSavingName] = useState(false);
  const [nameMsg, setNameMsg]       = useState("");
  const [nationality, setNationality] = useState("");
  const [natMsg, setNatMsg]           = useState("");
  const fileInputRef                = useRef(null);

  useEffect(() => {
    store.get("player_nationality").then(v => {
      if (v && v[user.uid]) setNationality(v[user.uid]);
    });
  }, [user.uid]);

  const saveNationality = async val => {
    setNationality(val);
    const nats = await store.get("player_nationality").then(v => v || {});
    if (val) {
      await store.set("player_nationality", { ...nats, [user.uid]: val });
    } else {
      const { [user.uid]: _, ...rest } = nats;
      await store.set("player_nationality", rest);
    }
    setNatMsg("Nationality saved.");
    setTimeout(() => setNatMsg(""), 3000);
  };

  const handlePhotoChange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const photoErr = validatePhoto(file);
    if (photoErr) { setUploadError(photoErr); return; }
    setUploadError(""); setUploading(true);
    try {
      const storageRef = ref(storage, `profile_photos/${user.uid}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await updateProfile(auth.currentUser, { photoURL: url });
      const photos = await store.get("player_photos").then(v => v || {});
      await store.set("player_photos", { ...photos, [user.uid]: url });
      onPhotoSaved(url);
    } catch (e) {
      setUploadError("Upload failed. Check Firebase Storage rules allow authenticated writes.");
    }
    setUploading(false);
  };

  const saveName = async () => {
    const cleaned = sanitizeText(nameVal, 100);
    const err = validateName(cleaned);
    if (err) { setNameMsg(err); return; }
    if (cleaned === user.displayName) { setEditingName(false); return; }
    setSavingName(true);
    try {
      await updateProfile(auth.currentUser, { displayName: cleaned });
      const names = await store.get("player_names").then(v => v || {});
      await store.set("player_names", { ...names, [user.uid]: cleaned });
      setNameMsg("Name updated.");
      setTimeout(() => setNameMsg(""), 3000);
    } catch { setNameMsg("Failed to save name."); }
    setSavingName(false);
    setEditingName(false);
  };

  const photoUrl = auth.currentUser?.photoURL;
  const initials = (user.displayName || user.email || "?")[0].toUpperCase();

  return (
    <div style={{maxWidth:"480px", margin:"0 auto"}}>
      <div className="page-title">My Profile</div>

      <div className="section-card" style={{marginBottom:"1.5rem"}}>
        {/* Photo */}
        <div style={{padding:"1.5rem 1.4rem", display:"flex", flexDirection:"column", alignItems:"center", gap:"1rem", borderBottom:"1px solid var(--cream-dark)"}}>
          <div style={{position:"relative"}}>
            {photoUrl
              ? <img src={photoUrl} alt="Profile" style={{width:"90px", height:"90px", borderRadius:"50%", objectFit:"cover", border:"3px solid var(--gold)", display:"block"}} />
              : <div style={{width:"90px", height:"90px", borderRadius:"50%", background:"var(--green-mid)", border:"3px solid var(--gold)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"2.2rem", color:"var(--cream)", fontFamily:"'Playfair Display',serif", fontWeight:700}}>
                  {initials}
                </div>
            }
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{position:"absolute", bottom:0, right:0, background:"var(--gold)", border:"none", borderRadius:"50%", width:"28px", height:"28px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.85rem"}}
              title="Upload photo"
            >Edit</button>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhotoChange} />
          {uploading && <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", color:"var(--text-light)"}}>Uploading…</div>}
          {uploadError && <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"#c0392b"}}>{uploadError}</div>}
          <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", color:"var(--text-light)", textAlign:"center"}}>
            Click Edit to upload a photo · Max 2 MB · JPG or PNG
          </div>
        </div>

        {/* Details */}
        <div style={{padding:"1.2rem 1.4rem", display:"flex", flexDirection:"column", gap:"1rem"}}>
          {/* Name */}
          <div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"4px"}}>Name</div>
            {editingName ? (
              <div style={{display:"flex", gap:"6px", alignItems:"center"}}>
                <input
                  value={nameVal}
                  onChange={e => setNameVal(e.target.value)}
                  onKeyDown={e => { if (e.key==="Enter") saveName(); if (e.key==="Escape") setEditingName(false); }}
                  autoFocus
                  style={{fontFamily:"'Crimson Text',serif", fontSize:"1rem", background:"var(--green-deep)", color:"var(--cream)", border:"1px solid var(--gold)", borderRadius:"2px", padding:"4px 10px", flex:1}}
                />
                <button className="pick-btn on" style={{fontSize:"0.78rem"}} onClick={saveName} disabled={savingName}>{savingName?"Saving…":"Save"}</button>
                <button className="pick-btn" style={{fontSize:"0.78rem"}} onClick={() => setEditingName(false)}>Cancel</button>
              </div>
            ) : (
              <div style={{display:"flex", alignItems:"center", gap:"8px"}}>
                <span style={{fontFamily:"'Crimson Text',serif", fontSize:"1.05rem", fontWeight:600}}>{user.displayName || <em style={{color:"var(--text-light)"}}>Not set</em>}</span>
                <button className="pick-btn" style={{fontSize:"0.74rem", padding:"2px 8px"}} onClick={() => { setNameVal(user.displayName || ""); setEditingName(true); }}>Edit</button>
              </div>
            )}
            {nameMsg && <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"#2e7d32", marginTop:"4px"}}>{nameMsg}</div>}
          </div>

          {/* Email */}
          <div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"4px"}}>Email</div>
            <span style={{fontFamily:"'Crimson Text',serif", fontSize:"1rem"}}>{user.email}</span>
          </div>

          {/* Nationality */}
          <div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"2px"}}>Nationality</div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", marginBottom:"8px"}}>
              Your flag appears next to your name on leaderboards.
            </div>
            <div style={{display:"flex", alignItems:"center", gap:"10px"}}>
              {nationality && getNatCode(nationality)
                ? <NatFlag nationality={nationality} size={40} />
                : <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", opacity:0.5}}>No flag</span>
              }
              <select
                value={nationality}
                onChange={e => saveNationality(e.target.value)}
                style={{fontFamily:"'Crimson Text',serif", fontSize:"1rem", background:"var(--green-deep)", color:"var(--cream)", border:`1px solid ${nationality ? "var(--cream-dark)" : "var(--gold)"}`, borderRadius:"2px", padding:"6px 10px", cursor:"pointer"}}
              >
                <option value="">— Select your country —</option>
                {NATIONALITIES.map(n => (
                  <option key={n.name} value={n.name}>{n.flag} {n.name}</option>
                ))}
              </select>
            </div>
            {natMsg && <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.8rem", color:"#2e7d32", marginTop:"4px"}}>{natMsg}</div>}
          </div>

          {/* Account type */}
          <div>
            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginBottom:"4px"}}>Sign-in method</div>
            <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.95rem", color:"var(--text-mid)"}}>
              {user.providerData?.[0]?.providerId === "google.com" ? "Google" : "Email & password"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Participant Dashboard (Admin) ────────────────────────────────────────────
function ParticipantDashboard() {
  const [data, setData]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [allUsers, setAllUsers]       = useState([]);
  const [dashTab, setDashTab]         = useState("tournaments");
  const [playerNames, setPlayerNames] = useState({});
  const [playerStats, setPlayerStats] = useState([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsLoaded, setStatsLoaded]   = useState(false);
  const [editUid, setEditUid]         = useState(null);
  const [editVal, setEditVal]         = useState("");
  const [saving, setSaving]           = useState(false);
  const [activityLogs, setActivityLogs] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoaded, setActivityLoaded]   = useState(false);
  const [playerEmails, setPlayerEmails] = useState({});
  const [playerMobiles, setPlayerMobiles] = useState({});
  const [editMobileUid, setEditMobileUid] = useState(null);
  const [editMobileVal, setEditMobileVal] = useState("");
  const [savingMobile, setSavingMobile]   = useState(false);
  const [tournamentPaidMaps, setTournamentPaidMaps] = useState({}); // { [tid]: { [uid]: boolean } } — matches paid__${tid} in Firestore
  const [savingPaid, setSavingPaid]     = useState(false);
  const [hiddenTids, setHiddenTids]     = useState(new Set()); // tournament IDs toggled off by admin
  const [deletingUid, setDeletingUid]   = useState(null);
  const [deleting, setDeleting]         = useState(false);
  const [deletingEntry, setDeletingEntry] = useState(null); // { uid, tid, name, tournamentName }
  const [deletingEntryInProgress, setDeletingEntryInProgress] = useState(false);
  const [playerNationalities, setPlayerNationalities] = useState({});
  const [editNatUid, setEditNatUid]     = useState(null);
  const [savingNat, setSavingNat]       = useState(false);
  const [expectedMaps, setExpectedMaps] = useState({}); // { [tid]: { [uid]: boolean } }

  useEffect(() => {
    (async () => {
      setLoading(true);
      const evs = await fetchTournaments();
      const sorted = [...evs].sort((a,b) => new Date(b.date) - new Date(a.date));
      const now = Date.now();
      const relevant = sorted.filter(e => new Date(e.date).getTime() <= now + 7*24*60*60*1000);
      const userMap = {};
      const [rows, savedNames, savedEmails, savedHidden, expectedEntries, initPaidEntries] = await Promise.all([
        Promise.all(relevant.map(async ev => {
          const [allPicksRaw, lockState, revealState] = await Promise.all([
            store.get(`allpicks__${ev.id}`).then(v => v || {}),
            store.get(`lock__${ev.id}`),
            store.get(`reveal__${ev.id}`),
          ]);
          const entrants = Object.values(allPicksRaw);
          entrants.forEach(e => { userMap[e.userId] = e.displayName; });
          return {
            tournament: ev,
            entrants,
            locked:   !!lockState?.locked,
            lockedAt: lockState?.at || null,
            lockedBy: lockState?.by || null,
            revealed: !!revealState?.revealed,
          };
        })),
        store.get("player_names").then(v => v || {}),
        store.get("player_emails").then(v => v || {}),
        store.get("hidden_tournaments").then(v => v || []),
        Promise.all(relevant.map(ev =>
          store.get(`expected__${ev.id}`).then(v => ({ tid: ev.id, v: v || {} }))
        )),
        Promise.all(relevant.map(ev =>
          store.get(`paid__${ev.id}`).then(v => ({ tid: ev.id, v: v || {} }))
        )),
      ]);
      // Seed with all registered users (even those with no tournament entries)
      Object.entries(savedEmails).forEach(([uid, email]) => {
        if (!userMap[uid]) userMap[uid] = savedNames[uid] || email.split("@")[0];
      });
      // Apply saved name overrides for entry-based users too
      Object.keys(userMap).forEach(uid => {
        if (savedNames[uid]) userMap[uid] = savedNames[uid];
      });
      const expMaps = {};
      expectedEntries.forEach(({ tid, v }) => { expMaps[tid] = v; });
      const paidMapsInit = {};
      initPaidEntries.forEach(({ tid, v }) => { paidMapsInit[tid] = v; });
      setData(rows);
      setAllUsers(Object.entries(userMap).map(([uid, name]) => ({ uid, name })));
      setPlayerNames(savedNames);
      setHiddenTids(new Set(savedHidden));
      setExpectedMaps(expMaps);
      setTournamentPaidMaps(paidMapsInit);
      setLoading(false);
    })();
  }, []);

  // Lazy-load player stats when Players tab is selected
  useEffect(() => {
    if (dashTab !== "players" || statsLoaded || statsLoading || loading) return;
    (async () => {
      setStatsLoading(true);
      const now = Date.now();
      const withEntries = data.filter(row => row.entrants.length > 0 && !hiddenTids.has(row.tournament.id));

      const tourneyResults = await Promise.all(withEntries.map(async row => {
        const ev = row.tournament;
        const end = ev.endDate
          ? new Date(ev.endDate).getTime() + 24*60*60*1000
          : new Date(ev.date).getTime() + 4*24*60*60*1000;
        const isPast = end < now;

        if (!isPast) {
          return {
            id: ev.id, name: ev.name, date: ev.date,
            entrants: row.entrants.map(e => ({ uid: e.userId, displayName: e.displayName, position: null, outOf: row.entrants.length })),
          };
        }
        const [{ players: lp, espnCutScore }, savedCut] = await Promise.all([
          fetchLeaderboard(ev.id, ev.date),
          store.get(`cut__${ev.id}`),
        ]);
        const eff = (savedCut?.value ?? savedCut) ?? espnCutScore;
        const standings = row.entrants.map(entry => ({
          uid: entry.userId, displayName: entry.displayName,
          total: entry.picks.reduce((sum, pk) => {
            const live = lp.find(p => p.id === pk.id);
            return live ? sum + applyScoreRules(live, eff).adjusted : sum;
          }, 0),
        })).sort((a, b) => a.total - b.total);

        return {
          id: ev.id, name: ev.name, date: ev.date,
          entrants: standings.map((s, i) => ({ ...s, position: i + 1, outOf: standings.length })),
        };
      }));

      // Aggregate into per-player stats
      const [emails, mobiles, nats] = await Promise.all([
        store.get("player_emails").then(v => v || {}),
        store.get("player_mobile").then(v => v || {}),
        store.get("player_nationality").then(v => v || {}),
      ]);

      // Load per-tournament paid status from paid__${tid} — the same keys used by the tournament page
      const activeTids = data
        .filter(row => {
          if (hiddenTids.has(row.tournament.id)) return false;
          const start = new Date(row.tournament.date).getTime();
          const end = row.tournament.endDate
            ? new Date(row.tournament.endDate).getTime() + 24*60*60*1000
            : start + 4*24*60*60*1000;
          return now >= start && now <= end;
        })
        .map(row => row.tournament.id);
      const paidEntries = await Promise.all(activeTids.map(tid =>
        store.get(`paid__${tid}`).then(v => ({ tid, v: v || {} }))
      ));
      const paidMaps = {};
      paidEntries.forEach(({ tid, v }) => { paidMaps[tid] = v; });

      const statMap = {};
      // Seed with all registered users (even those with no tournament entries)
      Object.entries(emails).forEach(([uid, email]) => {
        statMap[uid] = { uid, displayName: playerNames[uid] || email.split("@")[0], results: [] };
      });
      withEntries.forEach(row => row.entrants.forEach(e => {
        if (!statMap[e.userId]) statMap[e.userId] = { uid: e.userId, displayName: playerNames[e.userId] || e.displayName, results: [] };
      }));
      tourneyResults.forEach(r => r.entrants.forEach(e => {
        if (statMap[e.uid]) statMap[e.uid].results.push({ id: r.id, name: r.name, date: r.date, position: e.position, outOf: e.outOf });
      }));
      Object.values(statMap).forEach(p => p.results.sort((a, b) => new Date(a.date) - new Date(b.date)));

      setPlayerStats(Object.values(statMap).sort((a, b) =>
        (playerNames[a.uid] || a.displayName).localeCompare(playerNames[b.uid] || b.displayName)
      ));
      setPlayerEmails(emails);
      setTournamentPaidMaps(prev => ({ ...prev, ...paidMaps }));
      setPlayerMobiles(mobiles);
      setPlayerNationalities(nats);
      setStatsLoading(false);
      setStatsLoaded(true);
    })();
  }, [dashTab, loading, statsLoaded, statsLoading, data, playerNames]);

  // Lazy-load activity logs when Activity tab is selected
  useEffect(() => {
    if (dashTab !== "activity" || activityLoaded || activityLoading) return;
    (async () => {
      setActivityLoading(true);
      const raw = await store.getByPrefix("activityLog__");
      const logs = Object.values(raw)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 200); // keep the 200 most recent
      setActivityLogs(logs);
      setActivityLoading(false);
      setActivityLoaded(true);
    })();
  }, [dashTab, activityLoaded, activityLoading]);

  const saveName = async uid => {
    const cleaned = sanitizeText(editVal, 100);
    if (validateName(cleaned)) return; // reject silently — admin context
    setSaving(true);
    const updated = { ...playerNames, [uid]: cleaned };
    await store.set("player_names", updated);
    setPlayerNames(updated);
    // Propagate updated name into all allpicks docs for this user
    await Promise.all(data.map(async row => {
      const raw = await store.get(`allpicks__${row.tournament.id}`);
      if (!raw?.[uid]) return;
      raw[uid] = { ...raw[uid], displayName: cleaned };
      await store.set(`allpicks__${row.tournament.id}`, raw);
    }));
    setPlayerStats(ps => ps.map(p => p.uid === uid ? { ...p, displayName: cleaned } : p));
    setAllUsers(au => au.map(u => u.uid === uid ? { ...u, name: cleaned } : u));
    setSaving(false);
    setEditUid(null);
  };

  const saveMobile = async uid => {
    const cleaned = sanitizeText(editMobileVal, 20);
    if (validateMobile(cleaned)) return; // reject malformed numbers silently — admin context
    setSavingMobile(true);
    const updated = { ...playerMobiles, [uid]: cleaned };
    await store.set("player_mobile", updated);
    setPlayerMobiles(updated);
    setSavingMobile(false);
    setEditMobileUid(null);
  };

  const saveNationality = async (uid, val) => {
    setSavingNat(true);
    const current = await store.get("player_nationality").then(v => v || {});
    if (val) {
      await store.set("player_nationality", { ...current, [uid]: val });
      setPlayerNationalities(prev => ({ ...prev, [uid]: val }));
    } else {
      const { [uid]: _, ...rest } = current;
      await store.set("player_nationality", rest);
      setPlayerNationalities(prev => { const { [uid]: _, ...r } = prev; return r; });
    }
    setSavingNat(false);
    setEditNatUid(null);
  };

  const togglePaid = async (uid, tournamentId) => {
    setSavingPaid(true);
    const current = tournamentPaidMaps[tournamentId] || {};
    const updated = { ...current, [uid]: !current[uid] };
    await store.set(`paid__${tournamentId}`, updated);
    setTournamentPaidMaps(prev => ({ ...prev, [tournamentId]: updated }));
    setSavingPaid(false);
  };

  const toggleHiddenTournament = async (tid) => {
    const next = new Set(hiddenTids);
    if (next.has(tid)) next.delete(tid); else next.add(tid);
    setHiddenTids(next);
    await store.set("hidden_tournaments", [...next]);
    // Reset player stats so they reload without the toggled tournament
    setStatsLoaded(false);
    setPlayerStats([]);
  };

  const setExpected = async (uid, tid, value) => {
    const current = expectedMaps[tid] || {};
    const updated = { ...current };
    if (value === null) { delete updated[uid]; } else { updated[uid] = value; }
    await store.set(`expected__${tid}`, updated);
    setExpectedMaps(prev => ({ ...prev, [tid]: updated }));
  };

  const deletePlayer = async uid => {
    setDeleting(true);
    // Remove from all metadata docs
    const [emails, names, photos, mobiles] = await Promise.all([
      store.get("player_emails").then(v => v || {}),
      store.get("player_names").then(v => v || {}),
      store.get("player_photos").then(v => v || {}),
      store.get("player_mobile").then(v => v || {}),
    ]);
    delete emails[uid]; delete names[uid]; delete photos[uid]; delete mobiles[uid];
    await Promise.all([
      store.set("player_emails", emails),
      store.set("player_names", names),
      store.set("player_photos", photos),
      store.set("player_mobile", mobiles),
    ]);
    // Remove from all tournament picks
    await Promise.all(data.map(async row => {
      const tid = row.tournament.id;
      await store.del(`picks__${uid}__${tid}`);
      const allPicks = await store.get(`allpicks__${tid}`);
      if (allPicks?.[uid]) { delete allPicks[uid]; await store.set(`allpicks__${tid}`, allPicks); }
    }));
    // Update local state
    setPlayerStats(ps => ps.filter(p => p.uid !== uid));
    setAllUsers(au => au.filter(u => u.uid !== uid));
    setDeletingUid(null);
    setDeleting(false);
  };

  const deleteEntry = async ({ uid, tid }) => {
    setDeletingEntryInProgress(true);
    await store.del(`picks__${uid}__${tid}`);
    const allPicks = await store.get(`allpicks__${tid}`);
    if (allPicks?.[uid]) { delete allPicks[uid]; await store.set(`allpicks__${tid}`, allPicks); }
    setData(prev => prev.map(row =>
      row.tournament.id === tid
        ? { ...row, entrants: row.entrants.filter(e => e.userId !== uid) }
        : row
    ));
    setDeletingEntry(null);
    setDeletingEntryInProgress(false);
  };

  const fmtDate = d => new Date(d).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
  const fmtDateTime = ts => ts ? new Date(ts).toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : "–";
  const fmtDateTimeGMT = ts => ts ? new Date(ts).toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", timeZone:DISPLAY_TZ }) + " " + tzLabel() : "–";
  const posChip = (position, tournamentName, date) => {
    const label = position ? `#${position}` : "–";
    const isGold = position === 1;
    const isPending = position === null;
    return (
      <span
        title={`${tournamentName} · ${new Date(date).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}`}
        style={{
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          minWidth:"30px", padding:"2px 6px", borderRadius:"3px", cursor:"default",
          background: isGold?"rgba(201,168,76,0.15)":isPending?"rgba(100,100,100,0.08)":"rgba(45,90,39,0.1)",
          border:`1px solid ${isGold?"rgba(201,168,76,0.45)":isPending?"rgba(120,120,120,0.2)":"rgba(45,90,39,0.2)"}`,
          fontFamily:"'EB Garamond',serif", fontSize:"0.8rem",
          color: isGold?"var(--gold)":isPending?"var(--text-light)":"var(--text-mid)",
        }}
      >{label}</span>
    );
  };

  return (
    <div>
      <div className="page-title">Admin</div>
      <div className="page-subtitle">Participation overview across all tournaments</div>

      {deletingEntry && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"var(--white)",borderRadius:"6px",padding:"1.5rem 2rem",maxWidth:"360px",width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:"1.1rem",color:"var(--green-deep)",marginBottom:"0.75rem"}}>Delete Entry?</div>
            <div style={{fontFamily:"'EB Garamond',serif",fontSize:"0.92rem",color:"var(--text-mid)",marginBottom:"1.25rem"}}>
              Remove <strong>{deletingEntry.name}</strong>'s entry from <strong>{deletingEntry.tournamentName}</strong>? This cannot be undone.
            </div>
            <div style={{display:"flex",gap:"0.75rem",justifyContent:"flex-end"}}>
              <button className="btn-sm" onClick={() => setDeletingEntry(null)} disabled={deletingEntryInProgress}>Cancel</button>
              <button
                className="btn-sm"
                style={{background:"#c0392b",color:"#fff",borderColor:"#c0392b"}}
                onClick={() => deleteEntry(deletingEntry)}
                disabled={deletingEntryInProgress}
              >{deletingEntryInProgress ? "Deleting…" : "Delete"}</button>
            </div>
          </div>
        </div>
      )}

      <div className="tab-bar">
        <div className={`tab ${dashTab==="tournaments"?"active":""}`} onClick={() => setDashTab("tournaments")}>Tournaments</div>
        <div className={`tab ${dashTab==="players"?"active":""}`} onClick={() => setDashTab("players")}>Players</div>
        <div className={`tab ${dashTab==="activity"?"active":""}`} onClick={() => setDashTab("activity")}>Activity Log</div>
      </div>

      {loading ? <div className="loading">Loading dashboard…</div> : dashTab === "tournaments" ? (
        <>
          {/* Summary stats */}
          <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:"1rem", marginBottom:"2rem"}}>
            {[
              { label:"Total Users",    value: allUsers.length },
              { label:"Tournaments",    value: data.filter(r => isMajor(r.tournament.name)).length },
              { label:"Total Entries",  value: data.filter(r => isMajor(r.tournament.name)).reduce((s,r) => s + r.entrants.length, 0) },
            ].map(stat => (
              <div key={stat.label} style={{background:"var(--white)", border:"1px solid var(--cream-dark)", borderRadius:"4px", padding:"1rem 1.2rem", textAlign:"center"}}>
                <div style={{fontFamily:"'Playfair Display',serif", fontSize:"2rem", color:"var(--green-deep)", lineHeight:1}}>{stat.value}</div>
                <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)", marginTop:"4px"}}>{stat.label}</div>
              </div>
            ))}
          </div>

          {/* Per-tournament breakdown */}
          <div style={{display:"flex", flexDirection:"column", gap:"1rem"}}>
            {data.filter(row => isMajor(row.tournament.name)).map(row => {
              const entrantIds = new Set(row.entrants.map(e => e.userId));
              const missing = allUsers.filter(u => !entrantIds.has(u.uid));
              const isUpcoming = new Date(row.tournament.date).getTime() > Date.now();
              const tid = row.tournament.id;
              const expectedMap = expectedMaps[tid] || {};
              const paidMapForTid = tournamentPaidMaps[tid] || {};
              const awaiting = missing.filter(u => expectedMap[u.uid] === true);
              const notExpecting = missing.filter(u => expectedMap[u.uid] === false);
              const unknownStatus = missing.filter(u => expectedMap[u.uid] !== true && expectedMap[u.uid] !== false);
              return (
                <div key={row.tournament.id} className="section-card">
                  <div className="s-head">
                    <div>
                      <div className="s-head-title">
                        {row.tournament.name}
                        {isMajor(row.tournament.name) && <span style={{marginLeft:"8px", background:"var(--gold)", color:"var(--green-deep)", fontFamily:"'EB Garamond',serif", fontSize:"0.68rem", padding:"1px 6px", borderRadius:"2px", fontWeight:700}}>Major</span>}
                        {isUpcoming && hiddenTids.has(row.tournament.id) && (
                          <span style={{marginLeft:"8px", background:"rgba(100,100,100,0.12)", color:"var(--text-light)", fontFamily:"'EB Garamond',serif", fontSize:"0.68rem", padding:"1px 6px", borderRadius:"2px", fontWeight:700}}>Hidden</span>
                        )}
                      </div>
                      <div className="s-head-sub">{fmtDate(row.tournament.date)}</div>
                    </div>
                    <div style={{display:"flex", gap:"6px", flexWrap:"wrap", alignItems:"center"}}>
                      {row.locked   && <span className="inline-tag" style={{background:"#2c1a1a", color:"#f0a0a0", border:"1px solid #7a2e2e"}}>Locked</span>}
                      {row.revealed && <span className="inline-tag" style={{background:"#1a2040", color:"#90b0f0", border:"1px solid #3050a0"}}>Revealed</span>}
                      {isUpcoming && (
                        <button
                          className="btn-sm"
                          title={hiddenTids.has(row.tournament.id) ? "Enable this tournament in player tracking" : "Hide this tournament from player tracking"}
                          style={{
                            background: hiddenTids.has(row.tournament.id) ? "rgba(45,90,39,0.1)" : "rgba(192,57,43,0.1)",
                            color: hiddenTids.has(row.tournament.id) ? "var(--green-deep)" : "#c0392b",
                            border: hiddenTids.has(row.tournament.id) ? "1px solid rgba(45,90,39,0.3)" : "1px solid rgba(192,57,43,0.3)",
                          }}
                          onClick={() => toggleHiddenTournament(row.tournament.id)}
                        >
                          {hiddenTids.has(row.tournament.id) ? "Enable tracking" : "Hide from tracking"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{padding:"0.8rem 1.2rem"}}>
                    <div style={{marginBottom:"0.6rem"}}>
                      <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)"}}>Entered ({row.entrants.length})</span>
                      <div style={{display:"flex", flexWrap:"wrap", gap:"4px", marginTop:"4px"}}>
                        {row.entrants.map(e => (
                          <span key={e.userId} style={{display:"inline-flex",alignItems:"center",gap:"4px",background:"rgba(45,90,39,0.12)", border:"1px solid rgba(45,90,39,0.25)", borderRadius:"20px", padding:"2px 8px 2px 10px", fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"var(--text-mid)"}}>
                            {playerNames[e.userId] || e.displayName}
                            <button
                              onClick={() => setDeletingEntry({ uid: e.userId, tid: row.tournament.id, name: playerNames[e.userId] || e.displayName, tournamentName: row.tournament.name })}
                              title="Delete entry"
                              style={{background:"none",border:"none",cursor:"pointer",color:"#b05050",padding:"0 1px",lineHeight:1,fontSize:"0.85rem",fontFamily:"monospace"}}
                            >×</button>
                          </span>
                        ))}
                        {row.entrants.length === 0 && <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", fontStyle:"italic"}}>No entries yet</span>}
                      </div>
                    </div>
                    {isUpcoming && awaiting.length > 0 && (
                      <div style={{marginBottom:"0.6rem"}}>
                        <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"#a05c00"}}>Awaiting entry ({awaiting.length})</span>
                        <div style={{display:"flex", flexWrap:"wrap", gap:"4px", marginTop:"4px"}}>
                          {awaiting.map(u => {
                            const isPaid = !!paidMapForTid[u.uid];
                            return (
                              <span key={u.uid} style={{display:"inline-flex",alignItems:"center",gap:"4px",background:"rgba(180,110,0,0.1)", border:"1px solid rgba(180,110,0,0.3)", borderRadius:"20px", padding:"2px 6px 2px 10px", fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#9a6010"}}>
                                {playerNames[u.uid] || u.name}
                                <button
                                  onClick={() => togglePaid(u.uid, tid)}
                                  disabled={savingPaid}
                                  title={isPaid ? "Mark as unpaid" : "Mark as paid"}
                                  style={{background: isPaid ? "rgba(45,90,39,0.15)" : "rgba(192,57,43,0.15)", border: isPaid ? "1px solid rgba(45,90,39,0.4)" : "1px solid rgba(192,57,43,0.4)", borderRadius:"10px", cursor:"pointer", color: isPaid ? "var(--green-deep)" : "#c0392b", padding:"0 5px", lineHeight:"1.4", fontSize:"0.68rem", fontFamily:"'EB Garamond',serif"}}
                                >{isPaid ? "✓ Paid" : "Unpaid"}</button>
                                <button
                                  onClick={() => setExpected(u.uid, tid, null)}
                                  title="Remove expected mark"
                                  style={{background:"none",border:"none",cursor:"pointer",color:"#a06010",padding:"0 1px",lineHeight:1,fontSize:"0.85rem",fontFamily:"monospace"}}
                                >×</button>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {isUpcoming && notExpecting.length > 0 && (
                      <div style={{marginBottom:"0.6rem"}}>
                        <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--text-light)"}}>Not expecting entry ({notExpecting.length})</span>
                        <div style={{display:"flex", flexWrap:"wrap", gap:"4px", marginTop:"4px"}}>
                          {notExpecting.map(u => (
                            <span key={u.uid} style={{display:"inline-flex",alignItems:"center",gap:"4px",background:"rgba(100,100,100,0.07)", border:"1px solid rgba(100,100,100,0.18)", borderRadius:"20px", padding:"2px 8px 2px 10px", fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"var(--text-light)"}}>
                              {playerNames[u.uid] || u.name}
                              <button
                                onClick={() => setExpected(u.uid, tid, null)}
                                title="Clear status"
                                style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-light)",padding:"0 1px",lineHeight:1,fontSize:"0.85rem",fontFamily:"monospace"}}
                              >×</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {isUpcoming && unknownStatus.length > 0 && (
                      <div style={{marginBottom:"0.6rem"}}>
                        <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.76rem", letterSpacing:"0.1em", textTransform:"uppercase", color:"#b05050"}}>Not entered ({unknownStatus.length})</span>
                        <div style={{display:"flex", flexWrap:"wrap", gap:"4px", marginTop:"4px"}}>
                          {unknownStatus.map(u => (
                            <span key={u.uid} style={{display:"inline-flex",alignItems:"center",gap:"5px",background:"rgba(180,60,60,0.08)", border:"1px solid rgba(180,60,60,0.2)", borderRadius:"20px", padding:"2px 8px 2px 10px", fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#b07070"}}>
                              {playerNames[u.uid] || u.name}
                              <button
                                onClick={() => setExpected(u.uid, tid, true)}
                                title="Mark as expected to enter"
                                style={{background:"none",border:"none",cursor:"pointer",color:"#6a8060",padding:"0 1px",lineHeight:1,fontSize:"0.85rem",fontFamily:"monospace"}}
                              >+</button>
                              <button
                                onClick={() => setExpected(u.uid, tid, false)}
                                title="Mark as not expecting entry"
                                style={{background:"none",border:"none",cursor:"pointer",color:"#909090",padding:"0 1px",lineHeight:1,fontSize:"0.85rem",fontFamily:"monospace"}}
                              >−</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {row.locked && row.lockedAt && (
                      <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.74rem", color:"var(--text-light)", marginTop:"4px"}}>
                        Locked {fmtDateTimeGMT(row.lockedAt)} by {row.lockedBy}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : dashTab === "activity" ? (
        // ── Activity Log tab ──
        activityLoading ? <div className="loading">Loading activity log…</div> : (
          <div className="section-card">
            <div className="s-head">
              <div>
                <div className="s-head-title">Activity Log</div>
                <div className="s-head-sub">Recent user actions · {activityLogs.length} entries loaded</div>
              </div>
              <button className="btn-sm" onClick={() => { setActivityLoaded(false); setActivityLogs([]); }}>Refresh</button>
            </div>
            {activityLogs.length === 0 ? (
              <div className="empty">No activity recorded yet.</div>
            ) : (
              <div className="lb-table-wrap">
                <table className="lb-table">
                  <thead>
                    <tr>
                      <th style={{width:"140px"}}>Time</th>
                      <th>User</th>
                      <th>Action</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityLogs.map((log, i) => {
                      const actionLabels = {
                        login:             "Login",
                        register:          "Register",
                        tournament_viewed: "Viewed tournament",
                        picks_saved:       "Saved picks",
                      };
                      const label = actionLabels[log.action] || log.action;
                      const detailStr = log.action === "picks_saved" && log.details?.picks
                        ? log.details.picks.join(", ")
                        : log.action === "tournament_viewed" && log.details?.tournamentName
                          ? log.details.tournamentName
                          : log.details?.method || "";
                      return (
                        <tr key={i}>
                          <td style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"var(--text-light)", whiteSpace:"nowrap"}}>
                            {fmtDateTime(log.timestamp)}
                          </td>
                          <td style={{fontFamily:"'Crimson Text',serif", fontSize:"0.9rem"}}>
                            {log.userEmail}
                          </td>
                          <td style={{fontFamily:"'EB Garamond',serif", fontSize:"0.84rem", whiteSpace:"nowrap"}}>
                            {label}
                          </td>
                          <td style={{fontFamily:"'Crimson Text',serif", fontSize:"0.84rem", color:"var(--text-light)", maxWidth:"280px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                            {detailStr}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      ) : (
        // ── Players tab ──
        statsLoading ? <div className="loading">Computing player stats…</div> : (() => {
          const now = Date.now();
          // Tournaments currently live (started but not yet ended), excluding any the admin has hidden
          const activeTournaments = data.filter(row => {
            if (hiddenTids.has(row.tournament.id)) return false;
            const start = row.tournament.date ? new Date(row.tournament.date).getTime() : null;
            const end   = row.tournament.endDate ? new Date(row.tournament.endDate).getTime() + 24*60*60*1000 : (start ? start + 4*24*60*60*1000 : null);
            return start && end && now >= start && now <= end;
          });

          return (
            <div style={{display:"flex", flexDirection:"column", gap:"1rem"}}>
              {playerStats.map(player => {
                const name = playerNames[player.uid] || player.displayName;
                const email = playerEmails[player.uid] || null;
                const isEditing = editUid === player.uid;
                const pastResults = player.results.filter(r => r.position !== null);
                const bestFinish = pastResults.reduce((b, r) => b === null || r.position < b ? r.position : b, null);
                // Active tournaments this player has entered
                const activeEntries = activeTournaments.filter(row =>
                  row.entrants.some(e => e.userId === player.uid)
                );
                const unpaidEntries = activeEntries.filter(row =>
                  !(tournamentPaidMaps[row.tournament.id]?.[player.uid])
                );
                const hasUnpaid = unpaidEntries.length > 0;

                return (
                  <div key={player.uid} className="section-card" style={{
                    border: hasUnpaid ? "2px solid #c0392b" : "1px solid var(--cream-dark)",
                    background: hasUnpaid ? "rgba(192,57,43,0.04)" : "var(--white)",
                  }}>
                    <div style={{padding:"0.9rem 1.2rem", display:"flex", flexDirection:"column", gap:"0.55rem"}}>

                      {/* Header row: name + unpaid alert */}
                      <div style={{display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:"0.5rem"}}>
                        <div>
                          {isEditing ? (
                            <span style={{display:"flex", gap:"6px", alignItems:"center", flexWrap:"wrap"}}>
                              <input
                                value={editVal}
                                onChange={e => setEditVal(e.target.value)}
                                onKeyDown={e => { if (e.key==="Enter") saveName(player.uid); if (e.key==="Escape") setEditUid(null); }}
                                autoFocus
                                style={{fontFamily:"'Crimson Text',serif", fontSize:"0.95rem", background:"var(--green-deep)", color:"var(--cream)", border:"1px solid var(--gold)", borderRadius:"2px", padding:"3px 8px", width:"160px"}}
                              />
                              <button className="pick-btn on" style={{fontSize:"0.75rem", padding:"3px 10px"}} onClick={() => saveName(player.uid)} disabled={saving}>
                                {saving ? "Saving…" : "Save"}
                              </button>
                              <button className="pick-btn" style={{fontSize:"0.75rem", padding:"3px 10px"}} onClick={() => setEditUid(null)} disabled={saving}>Cancel</button>
                            </span>
                          ) : (
                            <div style={{display:"flex", alignItems:"center", gap:"8px", flexWrap:"wrap"}}>
                              <span style={{fontFamily:"'Crimson Text',serif", fontWeight:600, fontSize:"1.05rem"}}>{name}</span>
                              <button className="pick-btn" style={{fontSize:"0.72rem", padding:"2px 8px"}}
                                onClick={() => { setEditUid(player.uid); setEditVal(name); }}>Edit name</button>
                              {deletingUid === player.uid ? (
                                <span style={{display:"flex", alignItems:"center", gap:"6px"}}>
                                  <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", color:"#c0392b"}}>Delete this player?</span>
                                  <button className="btn-sm warn" disabled={deleting} onClick={() => deletePlayer(player.uid)}>{deleting ? "Deleting…" : "Yes, delete"}</button>
                                  <button className="btn-sm" disabled={deleting} onClick={() => setDeletingUid(null)}>Cancel</button>
                                </span>
                              ) : (
                                <button className="pick-btn" style={{fontSize:"0.72rem", padding:"2px 8px", color:"#c0392b", borderColor:"rgba(192,57,43,0.3)"}}
                                  onClick={() => setDeletingUid(player.uid)}>Delete</button>
                              )}
                            </div>
                          )}
                          {email && (
                            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", marginTop:"2px"}}>{email}</div>
                          )}
                          {/* Mobile number */}
                          {editMobileUid === player.uid ? (
                            <span style={{display:"flex", gap:"6px", alignItems:"center", flexWrap:"wrap", marginTop:"4px"}}>
                              <input
                                type="tel"
                                value={editMobileVal}
                                onChange={e => setEditMobileVal(e.target.value)}
                                onKeyDown={e => { if (e.key==="Enter") saveMobile(player.uid); if (e.key==="Escape") setEditMobileUid(null); }}
                                autoFocus
                                placeholder="+353 87 123 4567"
                                style={{fontFamily:"'EB Garamond',serif", fontSize:"0.88rem", background:"var(--green-deep)", color:"var(--cream)", border:"1px solid var(--gold)", borderRadius:"2px", padding:"3px 8px", width:"160px"}}
                              />
                              <button className="pick-btn on" style={{fontSize:"0.72rem", padding:"2px 8px"}} onClick={() => saveMobile(player.uid)} disabled={savingMobile}>
                                {savingMobile ? "Saving…" : "Save"}
                              </button>
                              <button className="pick-btn" style={{fontSize:"0.72rem", padding:"2px 8px"}} onClick={() => setEditMobileUid(null)} disabled={savingMobile}>Cancel</button>
                            </span>
                          ) : (
                            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", marginTop:"2px", display:"flex", alignItems:"center", gap:"6px"}}>
                              {playerMobiles[player.uid]
                                ? <span>{playerMobiles[player.uid]}</span>
                                : <span style={{fontStyle:"italic"}}>No mobile number</span>
                              }
                              <button className="pick-btn" style={{fontSize:"0.68rem", padding:"1px 6px"}}
                                onClick={() => { setEditMobileUid(player.uid); setEditMobileVal(playerMobiles[player.uid] || ""); }}>
                                {playerMobiles[player.uid] ? "Edit" : "Add"}
                              </button>
                            </div>
                          )}

                          {/* Nationality */}
                          {editNatUid === player.uid ? (
                            <span style={{display:"flex", gap:"6px", alignItems:"center", flexWrap:"wrap", marginTop:"4px"}}>
                              <select
                                autoFocus
                                value={playerNationalities[player.uid] || ""}
                                onChange={e => saveNationality(player.uid, e.target.value)}
                                disabled={savingNat}
                                style={{fontFamily:"'Crimson Text',serif", fontSize:"0.88rem", background:"var(--green-deep)", color:"var(--cream)", border:"1px solid var(--gold)", borderRadius:"2px", padding:"3px 8px"}}
                              >
                                <option value="">— None —</option>
                                {NATIONALITIES.map(n => (
                                  <option key={n.name} value={n.name}>{n.flag} {n.name}</option>
                                ))}
                              </select>
                              <button className="pick-btn" style={{fontSize:"0.72rem", padding:"2px 8px"}} onClick={() => setEditNatUid(null)} disabled={savingNat}>Cancel</button>
                            </span>
                          ) : (
                            <div style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", marginTop:"2px", display:"flex", alignItems:"center", gap:"6px"}}>
                              {playerNationalities[player.uid]
                                ? <span style={{display:"flex", alignItems:"center", gap:"4px"}}><NatFlag nationality={playerNationalities[player.uid]} /> {playerNationalities[player.uid]}</span>
                                : <span style={{fontStyle:"italic"}}>No nationality set</span>
                              }
                              <button className="pick-btn" style={{fontSize:"0.68rem", padding:"1px 6px"}}
                                onClick={() => setEditNatUid(player.uid)}>
                                {playerNationalities[player.uid] ? "Edit" : "Add"}
                              </button>
                            </div>
                          )}
                        </div>

                        {hasUnpaid && (
                          <div style={{
                            background:"#c0392b", color:"#fff",
                            fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", fontWeight:700,
                            letterSpacing:"0.08em", textTransform:"uppercase",
                            padding:"3px 10px", borderRadius:"3px",
                          }}>
                            ⚠ Payment outstanding
                          </div>
                        )}
                      </div>

                      {/* Results row */}
                      <div style={{display:"flex", alignItems:"center", gap:"1rem", flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--text-light)"}}>
                          Results
                        </span>
                        <div style={{display:"flex", gap:"4px", flexWrap:"wrap", alignItems:"center"}}>
                          {player.results.length === 0
                            ? <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)", fontStyle:"italic"}}>No entries yet</span>
                            : player.results.map(r => <span key={r.id}>{posChip(r.position, r.name, r.date)}</span>)
                          }
                        </div>
                        {bestFinish && (
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.82rem", color:"var(--text-light)"}}>
                            Best: #{bestFinish}
                          </span>
                        )}
                      </div>

                      {/* Active tournament payment row */}
                      {activeEntries.length > 0 && (
                        <div style={{display:"flex", flexWrap:"wrap", gap:"6px", alignItems:"center", paddingTop:"4px", borderTop:"1px solid var(--cream-dark)"}}>
                          <span style={{fontFamily:"'EB Garamond',serif", fontSize:"0.78rem", letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--text-light)"}}>
                            Active:
                          </span>
                          {activeEntries.map(row => {
                            const paid = !!(tournamentPaidMaps[row.tournament.id]?.[player.uid]);
                            return (
                              <span key={row.tournament.id} style={{display:"flex", alignItems:"center", gap:"5px"}}>
                                <span style={{fontFamily:"'Crimson Text',serif", fontSize:"0.88rem", color:"var(--text-mid)"}}>{row.tournament.name}</span>
                                <button
                                  className="btn-sm"
                                  disabled={savingPaid}
                                  style={{
                                    background: paid ? "rgba(45,90,39,0.12)" : "#c0392b",
                                    color: paid ? "var(--green-deep)" : "#fff",
                                    border: paid ? "1px solid rgba(45,90,39,0.3)" : "none",
                                    fontSize:"0.72rem", padding:"2px 8px",
                                  }}
                                  onClick={() => togglePaid(player.uid, row.tournament.id)}
                                >
                                  {paid ? "✓ Paid" : "Mark paid"}
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}

                    </div>
                  </div>
                );
              })}
              {playerStats.length === 0 && <div className="empty">No players found.</div>}
            </div>
          );
        })()
      )}
    </div>
  );
}

// ─── Historical Archive ───────────────────────────────────────────────────────
function HistoricalArchive() {
  const [events, setEvents]   = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [evs, savedPlayerNames] = await Promise.all([
        fetchTournaments(),
        store.get("player_names").then(v => v || {}),
      ]);
      const past = [...evs]
        .filter(e => {
          const end = e.endDate ? new Date(e.endDate).getTime() + 24*60*60*1000
                                : new Date(e.date).getTime() + 4*24*60*60*1000;
          return end < Date.now();
        })
        .sort((a,b) => new Date(b.date) - new Date(a.date));

      const rows = await Promise.all(past.map(async ev => {
        const [allPicksRaw, savedCut, revealState] = await Promise.all([
          store.get(`allpicks__${ev.id}`).then(v => v || {}),
          store.get(`cut__${ev.id}`),
          store.get(`reveal__${ev.id}`),
        ]);
        const entrants = Object.values(allPicksRaw);
        if (entrants.length === 0) return null;

        const { players: lp, espnCutScore } = await fetchLeaderboard(ev.id, ev.date);
        const eff = (savedCut?.value ?? savedCut) ?? espnCutScore;

        const standings = entrants.map(entry => ({
          uid:         entry.userId,
          displayName: savedPlayerNames[entry.userId] || entry.displayName,
          picks:       entry.picks,
          total:       entry.picks.reduce((sum, pk) => {
            const live = lp.find(p => p.id === pk.id);
            if (!live) return sum;
            return sum + applyScoreRules(live, eff).adjusted;
          }, 0),
        })).sort((a,b) => a.total - b.total);

        return { tournament: ev, standings, cutScore: eff, revealed: !!revealState?.revealed };
      }));

      setResults(rows.filter(Boolean));
      setLoading(false);
    })();
  }, []);

  const sc = n => n<0?"su":n>0?"so":"se";

  if (loading) return <div className="loading">Loading past results…</div>;
  if (results.length === 0) return (
    <div className="info-banner">No completed tournaments yet. Results will appear here once events finish.</div>
  );

  return (
    <div style={{display:"flex", flexDirection:"column", gap:"1rem"}}>
      {results.map(r => (
        <div key={r.tournament.id} className="section-card">
          <div className="s-head" style={{cursor:"pointer"}} onClick={() => setExpanded(e => e === r.tournament.id ? null : r.tournament.id)}>
            <div>
              <div className="s-head-title">
                {r.tournament.name}
                {isMajor(r.tournament.name) && <span style={{marginLeft:"8px", background:"var(--gold)", color:"var(--green-deep)", fontFamily:"'EB Garamond',serif", fontSize:"0.68rem", padding:"1px 6px", borderRadius:"2px", fontWeight:700}}>Major</span>}
              </div>
              <div className="s-head-sub">
                {new Date(r.tournament.date).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}
                {" · "}{r.standings.length} participant{r.standings.length !== 1 ? "s" : ""}
              </div>
            </div>
            <div style={{color:"var(--gold)", fontFamily:"'EB Garamond',serif", fontSize:"1.2rem"}}>
              {expanded === r.tournament.id ? "▲" : "▼"}
            </div>
          </div>

          {/* Always show winner */}
          {r.standings.length > 0 && (
            <div style={{padding:"0.6rem 1.2rem", display:"flex", alignItems:"center", gap:"10px", borderBottom: expanded === r.tournament.id ? "1px solid var(--cream-dark)" : "none"}}>
              <span style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color:"var(--gold)", fontWeight:700}}>#1</span>
              <span style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem", color:"var(--text-dark)"}}>{r.standings[0].displayName}</span>
              <span className={sc(r.standings[0].total)} style={{marginLeft:"auto", fontFamily:"'Playfair Display',serif", fontSize:"1.1rem"}}>{formatScore(r.standings[0].total)}</span>
            </div>
          )}

          {/* Full standings when expanded */}
          {expanded === r.tournament.id && (
            <div>
              {r.standings.map((s,i) => (
                <div key={s.uid} style={{display:"grid", gridTemplateColumns:"40px 1fr auto", alignItems:"center", padding:"0.55rem 1.2rem", borderBottom:"1px solid var(--cream-dark)", background: i===0?"rgba(201,168,76,0.04)":""}}>
                  <div style={{fontFamily:"'Playfair Display',serif", color:"var(--gold)", fontSize:"0.95rem"}}>
                    {`#${i+1}`}
                  </div>
                  <div>
                    <div style={{fontFamily:"'Crimson Text',serif", fontWeight:600}}>{s.displayName}</div>
                    <div style={{fontSize:"0.75rem", color:"var(--text-light)", fontFamily:"'EB Garamond',serif"}}>
                      {s.picks.map(p => p.name).join(" · ")}
                    </div>
                  </div>
                  <div className={sc(s.total)} style={{fontFamily:"'Playfair Display',serif", fontSize:"1rem"}}>{formatScore(s.total)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
