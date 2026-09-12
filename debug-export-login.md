# Debug Session: export-login

## Status
- OPEN

## User Symptoms
- Export fails.
- User does not want to log in every time.
- Desired workflow matches MTOS behavior: stay logged in once, then pull the latest current-vs-previous-month comparisons using existing scans.

## Falsifiable Hypotheses
1. The export fails because the browser automation logs into the dashboard UI every run and that UI login step is timing out or drifting.
2. The app already persists API credentials, but the export path ignores that session and forces a second login through Playwright.
3. The export is slower and more failure-prone than necessary because it navigates the dashboard list UI for every keyword instead of using the latest known comparison pair directly.
4. The existing API data is already sufficient to resolve the most recent comparison months, so a simplified current-vs-previous flow can avoid extra selection complexity.
5. The failure is happening after login, inside keyword/map navigation or compare-modal selection, not at authentication.

## Evidence To Collect
- Confirm whether saved credentials are used automatically on app reload.
- Confirm whether exporter performs a fresh UI login regardless of existing app session.
- Confirm whether current export mode already defaults to current vs previous month.
- Confirm which steps in exporter are most likely to fail based on current control flow.

## Next Step
- Inspect runtime and code evidence, then propose the minimal verified path to keep the user logged in and export only latest comparisons.

## Evidence Collected
- The app already supports remembered credentials and silent re-login on reload via [public/app.js](file:///e:/HEATMAP%20EXTRACTOR/public/app.js#L15-L31) and [server.js](file:///e:/HEATMAP%20EXTRACTOR/server.js#L49-L81).
- The export path still performs a separate browser UI login every run in [runExport](file:///e:/HEATMAP%20EXTRACTOR/src/exporter.js#L265-L279) via [doLogin](file:///e:/HEATMAP%20EXTRACTOR/src/exporter.js#L36-L58).
- The app already defaults to the user's desired export mode, current vs previous month, in [index.html](file:///e:/HEATMAP%20EXTRACTOR/public/index.html#L56-L60) and [server.js](file:///e:/HEATMAP%20EXTRACTOR/server.js#L167-L168).
- Current extraction uses existing completed scans from the API; it does not trigger new scans. Month pairs are derived from available history before browser work starts in [server.js](file:///e:/HEATMAP%20EXTRACTOR/server.js#L182-L200) and [mapranking-api.js](file:///e:/HEATMAP%20EXTRACTOR/src/mapranking-api.js#L151-L214).
- The most failure-prone and slow section remains UI automation after login: client selection, keyword row navigation, compare modal opening, date picking, and screenshot capture in [exporter.js](file:///e:/HEATMAP%20EXTRACTOR/src/exporter.js#L279-L321).
