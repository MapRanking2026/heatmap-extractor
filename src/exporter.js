// Playwright automation: logs into dashboard.mapranking.com, opens each target
// keyword's "Ranking comparison" modal for the requested month pair, and
// screenshots it to a PNG. All PNGs are zipped by the caller.
//
// Locators favour visible text / roles over brittle CSS, and every failure
// drops a debug screenshot into output/_debug so selector drift is easy to fix.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { slug } from "./dateutil.js";

const DASHBOARD_BASE = "https://dashboard.mapranking.com";

function log(onProgress, level, message) {
  if (onProgress) onProgress({ level, message, at: new Date().toISOString() });
}

async function debugShot(page, dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${Date.now()}_${slug(name)}.png`), fullPage: true });
  } catch {
    /* best effort */
  }
}

// Wait until the two comparison maps have settled (spinners gone + a pause for
// Google Maps tiles to paint). The modal shows a loading spinner per side.
async function waitForMapsSettled(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Give tiles + pins time to render; the maps are canvas/DOM heavy.
  await page.waitForTimeout(2500);
}

async function doLogin(page, credentials, debugDir, onProgress) {
  log(onProgress, "info", "Logging in…");
  await page.goto(`${DASHBOARD_BASE}/login`, { waitUntil: "domcontentloaded" });

  const email = page.getByPlaceholder(/email/i).first();
  const pass = page.getByPlaceholder(/password/i).first();
  await email.waitFor({ timeout: 30000 });
  await email.fill(credentials.email);
  await pass.fill(credentials.password);

  const loginBtn = page.getByRole("button", { name: /^log in$/i });
  await loginBtn.click();

  // Success = we leave /login.
  try {
    await page.waitForURL((url) => !/\/login/.test(url.href), { timeout: 30000 });
  } catch {
    await debugShot(page, debugDir, "login-failed");
    throw new Error("Login did not complete — check the email/password.");
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  log(onProgress, "info", "Logged in.");
}

async function openHeatmapsList(page, debugDir, onProgress) {
  log(onProgress, "info", "Opening Local SEO Heatmaps…");
  // Expand Rank Tracker, then click Local SEO Heatmaps.
  const rankTracker = page.getByText(/^rank tracker$/i).first();
  await rankTracker.click({ timeout: 20000 }).catch(() => {});
  const heatmaps = page.getByText(/local seo heatmaps/i).first();
  await heatmaps.click({ timeout: 20000 });
  await page.waitForTimeout(1500);
  // The scan form ("Select Business" + "Scan") signals the page is ready.
  await page.getByText(/select business/i).first().waitFor({ timeout: 20000 }).catch(async () => {
    await debugShot(page, debugDir, "heatmaps-list-not-ready");
  });
}

async function selectBusiness(page, businessName, debugDir, onProgress) {
  log(onProgress, "info", `Selecting client: ${businessName}`);
  // Open the top business combobox. It shows "Select Business" or a current name.
  const selector = page
    .locator("div,button")
    .filter({ hasText: /select business/i })
    .first();
  await selector.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Click the option by exact business name (Playwright scrolls it into view).
  const exact = page.getByText(businessName, { exact: true });
  try {
    await exact.first().click({ timeout: 8000 });
  } catch {
    // Fallback: some rows include the address on a second line; match loosely.
    const loose = page.getByText(new RegExp(escapeRegExp(businessName), "i")).first();
    try {
      await loose.click({ timeout: 8000 });
    } catch {
      await debugShot(page, debugDir, "business-select-failed");
      throw new Error(`Could not select business "${businessName}" in the dropdown.`);
    }
  }
  await page.waitForTimeout(2000); // table repopulates
}

// Make sure we're on the heatmaps list with `businessName` selected, then open
// the given keyword's row. Re-selects the client only if its rows aren't shown.
async function ensureRowOpen(page, businessName, keyword, debugDir, onProgress) {
  // If we're on a /map detail view, return to the list first.
  if (/\/map/.test(page.url())) {
    await page.goBack().catch(() => {});
    await page.waitForTimeout(1000);
  }
  // If the scan form isn't visible, (re)open the heatmaps list.
  const listReady = await page.getByText(/select business/i).first().count().catch(() => 0);
  if (!listReady) {
    await openHeatmapsList(page, debugDir, onProgress);
  }
  // Is the keyword's row already present (client still selected)?
  const rowView = page
    .locator("tr, [role='row'], div")
    .filter({ hasText: new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i") })
    .filter({ has: page.getByRole("button", { name: /^view$/i }) });
  if (!(await rowView.count())) {
    await selectBusiness(page, businessName, debugDir, onProgress);
  }
  await openKeywordRow(page, keyword, debugDir);
}

// Click the "View" button on the table row for a given keyword → enters /map.
async function openKeywordRow(page, keyword, debugDir) {
  const row = page
    .locator("tr, [role='row'], div")
    .filter({ hasText: new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i") })
    .filter({ has: page.getByRole("button", { name: /^view$/i }) })
    .first();
  const view = row.getByRole("button", { name: /^view$/i }).first();
  try {
    await view.scrollIntoViewIfNeeded();
    await view.click({ timeout: 8000 });
  } catch {
    // Fallback: first View button on the page.
    await page.getByRole("button", { name: /^view$/i }).first().click({ timeout: 8000 }).catch(async () => {
      await debugShot(page, debugDir, `view-failed-${slug(keyword)}`);
      throw new Error(`Could not open the heatmap for keyword "${keyword}".`);
    });
  }
  await page.waitForURL(/\/map/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// On /map, switch the active keyword via the left-card keyword dropdown.
async function switchKeywordOnMap(page, keyword, debugDir) {
  // The keyword dropdown shows the current keyword text with a chevron.
  const dropdown = page.locator("[class*='select'], [role='combobox'], button, div")
    .filter({ hasText: /.+/ })
    .locator("visible=true");
  // Simpler: click the small keyword control in the info card, then pick option.
  const control = page.locator("div,button").filter({ hasText: /▾|⌄/ }).first();
  await control.click({ timeout: 4000 }).catch(() => {});
  const option = page.getByText(keyword, { exact: true }).first();
  try {
    await option.click({ timeout: 6000 });
    await page.waitForTimeout(1500);
    return true;
  } catch {
    await debugShot(page, debugDir, `switch-keyword-failed-${slug(keyword)}`);
    return false;
  }
}

// Open the Compare Dates modal from the /map view.
async function openCompareModal(page, debugDir) {
  // Click the centered scan-date header to expand the timeline.
  const dateHeader = page
    .locator("text=/\\d{1,2}(st|nd|rd|th)\\s+[A-Z][a-z]{2}\\s+20\\d{2}/")
    .first();
  await dateHeader.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);

  const compare = page.getByText(/compare dates/i).first();
  await compare.waitFor({ timeout: 8000 });
  await compare.click();
  // Modal heading confirms it opened.
  await page.getByText(/ranking comparison/i).first().waitFor({ timeout: 12000 });
  await page.waitForTimeout(800);
  return page.locator("div").filter({ hasText: /ranking comparison/i }).last();
}

// Set one of the two date dropdowns (index 0 = Before/left, 1 = After/right).
async function setCompareDate(page, index, targetLabels, debugDir) {
  // Collect candidate dropdown controls inside the modal, in DOM order.
  const controls = page
    .locator("text=/\\d{1,2}(st|nd|rd|th)\\s+[A-Z][a-z]{2}\\s+20\\d{2}/")
    .filter({ has: page.locator("svg, [class*='chevron'], [class*='arrow']") });
  let control = controls.nth(index);
  if ((await control.count()) === 0) {
    // Fallback: any date-looking clickable in the modal, by order.
    control = page.locator("[class*='select'],[role='button'],button")
      .filter({ hasText: /\d{1,2}(st|nd|rd|th)\s+[A-Z][a-z]{2}\s+20\d{2}/ })
      .nth(index);
  }
  await control.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);

  // Try each candidate label (exact scan label first, then loose month label).
  for (const label of targetLabels) {
    const opt = page.getByText(label, { exact: true }).first();
    if (await opt.count()) {
      try {
        await opt.click({ timeout: 4000 });
        await page.waitForTimeout(800);
        return true;
      } catch {
        /* try next */
      }
    }
  }
  // Loose fallback: an option containing the month+year (last label assumed monthLabel).
  const monthLabel = targetLabels[targetLabels.length - 1];
  const loose = page.getByText(new RegExp(escapeRegExp(monthLabel), "i")).last();
  if (await loose.count()) {
    try {
      await loose.click({ timeout: 4000 });
      await page.waitForTimeout(800);
      return true;
    } catch {
      /* fall through */
    }
  }
  await debugShot(page, debugDir, `date-select-failed-${index}`);
  return false;
}

async function screenshotModal(page, filePath) {
  const modal = page.getByText(/ranking comparison/i).first()
    .locator("xpath=ancestor::*[self::div][1]");
  // Prefer a tight clip around the dialog; fall back to the dialog role.
  const dialog = page.locator("[role='dialog']").first();
  const target = (await dialog.count()) ? dialog : modal;
  await target.screenshot({ path: filePath });
}

async function closeModal(page) {
  const close = page.getByRole("button", { name: /close/i }).first();
  if (await close.count()) {
    await close.click().catch(() => {});
  } else {
    // The × icon; press Escape as a fallback.
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(500);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {object} args
 * @param {{email,password}} args.credentials
 * @param {{id,name}} args.business
 * @param {Array<{keyword, pairs: Array<{before, after, tag}>}>} args.targets
 *   before/after = { scanLabel, monthLabel } used to pick dropdown options.
 * @param {string} args.outDir   directory to write PNGs into
 * @param {boolean} args.headless
 * @param {function} args.onProgress
 * @returns {{files: string[], errors: Array}}
 */
export async function runExport({ credentials, business, targets, outDir, headless = true, onProgress }) {
  const debugDir = path.join(outDir, "_debug");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const files = [];
  const errors = [];

  try {
    await doLogin(page, credentials, debugDir, onProgress);
    await openHeatmapsList(page, debugDir, onProgress);
    await selectBusiness(page, business.name, debugDir, onProgress);

    // Reliable pattern: for each keyword, make sure the list shows this client's
    // rows, open the keyword's View → /map, do the comparisons, then go back to
    // the list for the next keyword. (Switching keywords via the on-/map
    // dropdown proved brittle, so we re-enter from the list each time.)
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      log(onProgress, "info", `Keyword ${i + 1}/${targets.length}: ${t.keyword}`);
      try {
        await ensureRowOpen(page, business.name, t.keyword, debugDir, onProgress);

        for (const pair of t.pairs) {
          const tag = pair.tag || `${slug(pair.before.monthLabel)}_vs_${slug(pair.after.monthLabel)}`;
          log(onProgress, "info", `  Comparing ${pair.before.monthLabel} → ${pair.after.monthLabel}`);
          await openCompareModal(page, debugDir);
          const okBefore = await setCompareDate(page, 0, [pair.before.scanLabel, pair.before.monthLabel], debugDir);
          const okAfter = await setCompareDate(page, 1, [pair.after.scanLabel, pair.after.monthLabel], debugDir);
          if (!okBefore || !okAfter) {
            errors.push({ keyword: t.keyword, tag, error: "Could not set one of the comparison dates." });
          }
          await waitForMapsSettled(page);

          const fileName = `${slug(t.keyword)}__${tag}.png`;
          const filePath = path.join(outDir, fileName);
          await screenshotModal(page, filePath);
          files.push(fileName);
          log(onProgress, "success", `  Saved ${fileName}`);
          await closeModal(page);
        }
        // Return to the list for the next keyword.
        await page.goBack().catch(() => {});
        await page.waitForTimeout(1200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ keyword: t.keyword, error: msg });
        log(onProgress, "error", `  ${t.keyword}: ${msg}`);
        await debugShot(page, debugDir, `keyword-error-${slug(t.keyword)}`);
        // Recover to the list for the next keyword.
        await closeModal(page).catch(() => {});
        await openHeatmapsList(page, debugDir, onProgress).catch(() => {});
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({ fatal: true, error: msg });
    log(onProgress, "error", msg);
  } finally {
    await browser.close().catch(() => {});
  }

  return { files, errors };
}

export { DASHBOARD_BASE };
