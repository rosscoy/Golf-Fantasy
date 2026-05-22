# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start local dev server (Vite HMR)
npm run build     # Build production bundle to /dist
npm run preview   # Preview production build locally
```

No test runner or linter is configured.

## Architecture

This is a **React 18 SPA** built with Vite, using Firebase (Firestore + Auth) as the backend and the ESPN public golf API for live scoring data. The entire application lives in a single file: `src/App.jsx` (~2600 lines). There is no routing library — conditional rendering drives all "page" navigation via React state.

### Key architectural patterns

**Single-file structure:** All components, styles (embedded `<style>` block), constants, and Firebase config are in `src/App.jsx`. `src/main.jsx` only mounts `<App />`.

**Firebase Firestore schema** (`golfFantasy` collection, all docs `{ value, updatedAt }`):
- `picks__{userId}__{tournamentId}` — user's selected golfers
- `allpicks__{tournamentId}` — all users' picks (for leaderboard)
- `lock__{tournamentId}` — pick lock state
- `reveal__{tournamentId}` — leaderboard visibility
- `cut__{tournamentId}` — cut score (manual or auto)
- `autolock__{tournamentId}` — scheduled lock time
- `tiers__{tournamentId}` — per-player tier overrides

**ESPN API** (public, no auth required):
- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=YYYYMMDD`
- Leaderboard: `https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?event={eventId}`

**Scoring logic:**
- Players who made the cut: score capped at `cutScore + 9`
- Missed cut / withdrawn: penalized to `cutScore + 10`
- If no cut score is available: fantasy score shown as null

**Tier system** (based on world rankings):
- Tier 1: ranks 1–10, Tier 2: 11–25, Tier 3: 26–50, Tier 4: 51–100, Tier 5: 101+
- Default for unranked players: Tier 3
- Team of 5 must have tier sum ≥ 13 (`TIER_MIN_SUM`)
- Admin can override individual player tiers per tournament

**Admin role:** Gated by hardcoded `ADMIN_EMAIL = "rosscoy95@gmail.com"`. Admin features: lock/unlock picks, schedule auto-lock, override cut score, manage tiers, view all entries.

**Live data refresh:** Auto-polls ESPN every 2 minutes during active tournaments.

### Pages (rendered via state, not routing)

| Page | Description |
|------|-------------|
| `AuthPage` | Login/register (email+password or Google OAuth) |
| `TournamentsPage` | Browse upcoming/live PGA events |
| `TournamentPage` | Core gameplay — pick golfers, view leaderboard, admin controls |
| `CompetitionPage` | Aggregate leaderboard across all participants |
| `MyResultsPage` | User's historical results |
| `ParticipantDashboard` | Admin — participation overview |
| `HistoricalArchive` | Past tournament standings |

### World rankings data

A static `WORLD_RANKINGS` object (ESPN player ID → world rank) is embedded in `App.jsx` and was last updated May 2026. When player rankings change significantly, this object needs manual updating.

## Deployment

Deployed on Vercel. Project ID: `prj_oJ6imXwDf85UbMzzb38J7eFEswdn` (team: `team_eacmJfhJqgPqg7phWGMGittC`).

Firebase config and `ADMIN_EMAIL` are hardcoded in `App.jsx` (not environment variables).


## Conventions & Preferences
- Personal/social project — keep solutions pragmatic, avoid over-engineering
- The single-file App.jsx structure is intentional for now — do not refactor into 
  separate files unless explicitly asked
- Prefer minimal new dependencies; ask before installing anything new
- Use clear, descriptive variable names

## Known Context
- Admin is hardcoded to rosscoy95@gmail.com — this is intentional for a private league
- WORLD_RANKINGS in App.jsx was last updated March 2026 and will need periodic updates
- ESPN API is public and unauthenticated — no API key needed but it can go down
- Firebase config is hardcoded in App.jsx (not env vars) — this is a known tradeoff for simplicity

## Do Not
- Do not move Firebase config or ADMIN_EMAIL to environment variables without discussing first
- Do not change the Firestore document key patterns (e.g. picks__{userId}__{tournamentId}) 
  without flagging impact on existing data
- Do not push directly to main without confirming — Vercel auto-deploys on every push
- Do not modify the tier system constants without checking impact on existing picks

## Current Focus
- [Update this as you work — e.g. "Adding season-long leaderboard" or "Fixing ESPN API timeout handling"]
