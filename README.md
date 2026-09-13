# Heatmap Extractor

Exports the real MapRanking **Ranking comparison** screen as PNGs in a ZIP. Choose any client profile, or several profiles, and all active scans are selected by default.

## Start

Run `npm install` once, then `npm start` in this folder. Open http://127.0.0.1:3000.

The server reads only `MAPRANKING_LOGIN_EMAIL` and `MAPRANKING_LOGIN_PASSWORD` from `E:\motsv7\apps\seoos\.env` and `.env.local`. Set `MTOS_ROOT` if MTOS 7 is somewhere else. Process environment settings can override the two login values. The extractor does not change MTOS files or copy their secrets. Legacy `config/credentials.json` is supported only as a fallback. Manual sign-in is kept in memory for the session.

## Export

1. Search and select one or multiple client profiles by name and address.
2. Load the profiles. Choose active, paused, or all scans.
3. Choose the comparison and optionally clear individual scans.
4. Export and download the ZIP. A folder identifies each profile by name and unique ID.

Current vs previous means the actual current UTC calendar month and the immediately preceding month. The latest **completed** report in each exact month is used. A missing month is listed as skipped; it is never replaced by an older month. Custom dates follow the same exact-month rule. Consecutive comparisons never bridge a missing month.

Active status comes from the dashboard's actual `paused` setting, not scan age. Each distinct scan configuration is preserved even when two have the same keyword. Every list page and each scan's full history are fetched.

The comparison uses the dashboard's native map rendering and metrics. Date options are selected using report IDs. The capture verifies the report's profile, scan and keyword identities, the selected date IDs, and the rendered pin labels. It uses existing completed reports and does not run new scans.

## Output and completeness

`output/<job-id>/` contains the PNGs, a text manifest, a JSON manifest, and job status. The ZIP contains only verified PNGs and manifests; debug screenshots are excluded. Failed and skipped captures are explicitly listed. A partial ZIP is labelled **PARTIAL**. No verified images means no downloadable ZIP.

Export status survives page reloads. An interrupted server job is marked failed after restart. Only one export runs at a time. The server listens on this computer's loopback address.

## Verification

`npm test` checks exact months, year rollover, active status, pagination, and report identity. Live verification is also necessary after a MapRanking UI change. The exporter fails instead of silently choosing a different keyword or date when it cannot verify a result.

## Files

- `src/mapranking-api.js`: authentication and complete read-only scan retrieval.
- `src/credentials.js`: MTOS credential discovery.
- `src/compare.js`: exact month selection, shared with the browser UI.
- `src/exporter.js`: native dashboard capture and verification.
- `server.js`: local session, export jobs, manifests, and ZIP download.
- `public/`: profile and scan selection UI.
