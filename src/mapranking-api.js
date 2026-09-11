// MapRanking dashboard API client.
// Base + endpoints reverse-engineered from the MtOS integration
// (E:\motsv7\apps\seoos\src\lib\server\sync\mapranking-client.ts) and verified
// live against dashboardapi.mapranking.com. Read-only here: we only fetch the
// data needed to populate the UI (clients, keywords, available scan months).
// The actual heatmap images are captured from the dashboard UI by the exporter.

import { scanLabel, monthKey, monthLabel } from "./dateutil.js";

const DEFAULT_API_BASE = "https://dashboardapi.mapranking.com";

function apiBase(override) {
  return (override || DEFAULT_API_BASE).replace(/\/$/, "");
}

async function postJson(base, path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (payload && typeof payload.message === "string" && payload.message) ||
        `MapRanking request failed (${res.status}) on ${path}`,
    );
  }
  return payload;
}

async function getJson(base, path, token) {
  const res = await fetch(base + path, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (payload && typeof payload.message === "string" && payload.message) ||
        `MapRanking request failed (${res.status}) on ${path}`,
    );
  }
  return payload;
}

/** Log in with email/password → bearer token. */
export async function login(email, password, baseOverride) {
  const base = apiBase(baseOverride);
  const payload = await postJson(base, "/api/auth/login", {
    type: "email",
    email,
    password,
  });
  const data = payload.data || {};
  const token = typeof data.token === "string" ? data.token : "";
  if (!token) throw new Error("Login succeeded but no token was returned.");
  return token;
}

/** All client businesses in the account (powers the searchable dropdown). */
export async function getBusinesses(token, baseOverride) {
  const base = apiBase(baseOverride);
  const payload = await getJson(base, "/api/business/get-business", token);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows
    .map((r) => ({
      id: String(r._id || ""),
      name: String(r.business_name || "").trim(),
      address: String(r.address || r.formatted_address || "").trim(),
    }))
    .filter((b) => b.id && b.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Raw keyword-history rows → one row per heatmap CONFIG (a keyword can have
// several config versions over time).
async function getKeywordConfigs(base, token, businessId) {
  const payload = await postJson(
    base,
    "/api/heatmap/keyword-history",
    { business_id: businessId },
    token,
  );
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const byKeyword = new Map();
  for (const r of rows) {
    const keyword = String(r.keyword || "").trim();
    const heatmapId = String(r.heatmap_id || "");
    if (!keyword || !heatmapId) continue;
    const list = byKeyword.get(keyword) || [];
    list.push({
      heatmapId,
      createdAt: String(r.created_at || ""),
      // Keep raw row so we can look for a paused/enabled flag if present.
      raw: r,
    });
    byKeyword.set(keyword, list);
  }
  return byKeyword;
}

// A single heatmap config's scan history → completed scans with dates + score.
async function getHeatmapHistory(base, token, heatmapId) {
  const payload = await postJson(
    base,
    "/api/heatmap/get-heatmap",
    { heatmapId },
    token,
  );
  const data = payload.data || {};
  const history = Array.isArray(data.history) ? data.history : [];
  const scans = [];
  for (const e of history) {
    const reportId = String(e.report_id || "");
    const timestamp = String(e.timestamp || "");
    if (!reportId || !timestamp || String(e.status || "") !== "completed") continue;
    const score = e.score || {};
    scans.push({
      reportId,
      timestamp,
      avgRank: numberOrNull(score.avg),
      marketSharePercent:
        numberOrNull(score.marketShare) === null
          ? null
          : Math.round(numberOrNull(score.marketShare) * 1000) / 10,
    });
  }
  return { scans, config: data };
}

function numberOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Heuristic for active vs paused. The API has no explicit flag we've confirmed,
// but an actively-scanning keyword has a completed scan within the recent past.
// Anything whose most recent scan is older than `activeWindowDays` is treated as
// paused. Tunable; refine once a real paused/enabled field is confirmed.
function classifyStatus(latestIso, activeWindowDays) {
  if (!latestIso) return "paused";
  const ageDays = (Date.now() - new Date(latestIso).getTime()) / 86_400_000;
  return ageDays <= activeWindowDays ? "active" : "paused";
}

/**
 * Full keyword picture for one client: every keyword, its available completed
 * scan months, and an active/paused classification. Merges scans across a
 * keyword's config versions so month history survives a config recreation.
 */
export async function getClientKeywords(token, businessId, opts = {}) {
  const base = apiBase(opts.baseOverride);
  const activeWindowDays = opts.activeWindowDays ?? 45;
  const byKeyword = await getKeywordConfigs(base, token, businessId);

  const keywords = [];
  for (const [keyword, configs] of byKeyword) {
    // Pull history for each config (newest configs first, cap for speed).
    const ordered = [...configs].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    const perConfig = await Promise.all(
      ordered.slice(0, 4).map((c) => getHeatmapHistory(base, token, c.heatmapId).catch(() => ({ scans: [] }))),
    );

    // Merge + dedupe scans by reportId across configs.
    const seen = new Set();
    let scans = [];
    for (const r of perConfig) {
      for (const s of r.scans) {
        if (seen.has(s.reportId)) continue;
        seen.add(s.reportId);
        scans.push(s);
      }
    }
    scans.sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // oldest → newest
    if (!scans.length) continue;

    // One representative scan per calendar month (the latest in that month),
    // since the user compares month-over-month.
    const byMonth = new Map();
    for (const s of scans) byMonth.set(monthKey(s.timestamp), s);
    const months = [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, s]) => ({
        key,
        monthLabel: monthLabel(s.timestamp),
        scanLabel: scanLabel(s.timestamp),
        timestamp: s.timestamp,
        reportId: s.reportId,
        avgRank: s.avgRank,
        marketSharePercent: s.marketSharePercent,
      }));

    const latest = scans[scans.length - 1];
    keywords.push({
      keyword,
      status: classifyStatus(latest.timestamp, activeWindowDays),
      scanCount: scans.length,
      monthCount: months.length,
      latestScan: latest.timestamp,
      latestScanLabel: scanLabel(latest.timestamp),
      months,
    });
  }

  keywords.sort((a, b) => a.keyword.localeCompare(b.keyword));
  return keywords;
}

export { DEFAULT_API_BASE };
