# Heatmap Extractor

One-button export of **Map Ranking geogrid heatmap comparisons** for any client —
current vs previous month (or any range you pick), for all active keywords,
delivered as a **ZIP of PNGs** you can email to clients or drop into reports.

It logs into your `dashboard.mapranking.com` account, opens each keyword's
**Ranking comparison** (the native Before/After view), and screenshots it — no
going keyword-by-keyword by hand.

## What it does

1. **Pick a client** — searchable dropdown of every business in your account.
2. **Pick what to export**
   - Keyword status: **Active** (default), Paused, or All.
   - Comparison: **This month vs last month** (default), **Since the beginning → now**,
     **Every month-over-month**, or **Pick two months**.
   - Tick the exact keywords (defaults to all that have ≥2 months of scans).
3. **Export** → the tool drives the dashboard and saves one comparison PNG per
   keyword, then hands you a ZIP.

## Setup (one time)

Requires **Node.js 18+** (Windows).

```bash
npm install
```

That also downloads the browser engine (Chromium, ~130 MB) the tool uses to open
the dashboard.

## Run

```bash
npm start
```

Then open **http://localhost:3000** and sign in with your Map Ranking dashboard
email + password. Tick *Remember on this computer* to skip it next time.

- Your login is stored **only on this computer** (in `config/credentials.json`,
  which is git-ignored) and is used solely to open the dashboard. It is never
  sent anywhere else.
- Leave **"Show the browser while it runs"** checked the first few times so you
  can watch it work.

## Output

- The ZIP contains one PNG per keyword named
  `keyword__2026-07_vs_2026-08.png`, plus a `manifest.txt`.
- Working files (and debug screenshots if something fails) are left in
  `output/<jobId>/` — safe to delete.

## Notes & limits

- A keyword needs **at least two months of completed scans** to be compared;
  keywords with only one scan are skipped (and listed in the log).
- "Active" vs "Paused" is inferred from recency of the last scan (default: a scan
  within 45 days = active). Tune `activeWindowDays` in
  `src/mapranking-api.js` if needed.
- Because it screenshots the real dashboard, a big client (10–15 keywords) takes
  a few minutes, and a future dashboard redesign may require selector tweaks in
  `src/exporter.js`. If a run captures nothing, check `output/<jobId>/_debug/`
  for screenshots showing where it got stuck.

## How it's wired

| File | Role |
|---|---|
| `server.js` | Local web server: session, clients, keywords, export jobs, ZIP. |
| `src/mapranking-api.js` | Read-only dashboard API client (login, clients, per-keyword scan months). |
| `src/exporter.js` | Playwright automation: drives the dashboard and screenshots each comparison. |
| `src/compare.js` | Turns a comparison mode into concrete Before/After month pairs. |
| `public/` | The UI. |

The dashboard API + UI flow are documented from the MtOS integration
(`E:\motsv7\apps\seoos\src\lib\server\sync\mapranking-client.ts`).
