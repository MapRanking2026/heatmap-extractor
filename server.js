// Heatmap Extractor — local server.
// Serves the UI and exposes: session (login), clients, per-client keywords,
// and an export job that drives the dashboard and returns a ZIP of PNGs.

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";
import { fileURLToPath } from "node:url";

import { login, getBusinesses, getClientKeywords } from "./src/mapranking-api.js";
import { resolvePairs, pairLabel } from "./src/compare.js";
import { runExport } from "./src/exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pick a writable base for output/config. Prefer next to the app (so the user
// finds their files), but fall back to the OS temp dir if that root is
// read-only (e.g. a serverless/container filesystem).
function writableBase() {
  try {
    const probe = path.join(__dirname, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return __dirname;
  } catch {
    const alt = path.join(os.tmpdir(), "heatmap-extractor");
    fs.mkdirSync(alt, { recursive: true });
    console.warn(`\n  [warn] App directory is read-only; writing output to ${alt}\n`);
    return alt;
  }
}

const BASE_DIR = writableBase();
const CONFIG_DIR = path.join(BASE_DIR, "config");
const CRED_FILE = path.join(CONFIG_DIR, "credentials.json");
const OUTPUT_DIR = path.join(BASE_DIR, "output");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- In-memory session ----
let session = null; // { token, email, password }

function loadSavedCreds() {
  try {
    const raw = fs.readFileSync(CRED_FILE, "utf8");
    const c = JSON.parse(raw);
    if (c.email && c.password) return c;
  } catch {
    /* none */
  }
  return null;
}

function saveCreds(email, password) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify({ email, password }, null, 2), "utf8");
}

// ---- Session endpoints ----
app.get("/api/session", (req, res) => {
  res.json({ loggedIn: !!session, email: session?.email || null, savedCreds: !!loadSavedCreds() });
});

app.post("/api/session/login", async (req, res) => {
  const { email, password, remember } = req.body || {};
  const saved = loadSavedCreds();
  const useEmail = email || saved?.email;
  const usePassword = password || saved?.password;
  if (!useEmail || !usePassword) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  try {
    const token = await login(useEmail, usePassword);
    session = { token, email: useEmail, password: usePassword };
    if (remember) saveCreds(useEmail, usePassword);
    const businesses = await getBusinesses(token);
    res.json({ ok: true, email: useEmail, clientCount: businesses.length });
  } catch (e) {
    res.status(401).json({ error: e instanceof Error ? e.message : "Login failed." });
  }
});

app.post("/api/session/logout", (req, res) => {
  session = null;
  res.json({ ok: true });
});

app.post("/api/session/forget", (req, res) => {
  try {
    fs.rmSync(CRED_FILE, { force: true });
  } catch {
    /* ignore */
  }
  res.json({ ok: true });
});

function requireSession(req, res) {
  if (!session) {
    res.status(401).json({ error: "Not logged in." });
    return false;
  }
  return true;
}

// ---- Clients ----
app.get("/api/clients", async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const businesses = await getBusinesses(session.token);
    res.json({ clients: businesses });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load clients." });
  }
});

// ---- Keywords for a client ----
app.get("/api/clients/:id/keywords", async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const keywords = await getClientKeywords(session.token, req.params.id);
    res.json({ keywords });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load keywords." });
  }
});

// ---- Export jobs ----
const jobs = new Map(); // jobId -> { status, log:[], files, errors, zipPath, business, done }

function newJob() {
  const id = crypto.randomBytes(6).toString("hex");
  const job = { id, status: "starting", log: [], files: [], errors: [], zipPath: null, done: false };
  jobs.set(id, job);
  return job;
}

function pushLog(job, entry) {
  job.log.push(entry);
  if (job.log.length > 1000) job.log.shift();
}

async function zipDirectory(srcDir, outZip) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    // Add PNGs at zip root; skip the _debug folder.
    archive.glob("*.png", { cwd: srcDir });
    // Include a manifest if present.
    if (fs.existsSync(path.join(srcDir, "manifest.txt"))) {
      archive.file(path.join(srcDir, "manifest.txt"), { name: "manifest.txt" });
    }
    archive.finalize();
  });
}

app.post("/api/export", async (req, res) => {
  if (!requireSession(req, res)) return;
  const { clientId, keywords, status = "active", mode = "current_vs_previous", params = {}, headless = true } =
    req.body || {};
  if (!clientId) return res.status(400).json({ error: "clientId is required." });

  const job = newJob();
  res.json({ jobId: job.id }); // respond immediately; work continues async

  (async () => {
    try {
      const businesses = await getBusinesses(session.token);
      const business = businesses.find((b) => b.id === clientId);
      if (!business) throw new Error("Client not found.");
      job.business = business;
      pushLog(job, { level: "info", message: `Client: ${business.name}` });

      let kws = await getClientKeywords(session.token, clientId);
      // Status filter
      if (status !== "all") kws = kws.filter((k) => k.status === status);
      // Explicit keyword subset (by name)
      if (Array.isArray(keywords) && keywords.length) {
        const set = new Set(keywords.map((s) => s.toLowerCase()));
        kws = kws.filter((k) => set.has(k.keyword.toLowerCase()));
      }

      // Resolve comparison pairs per keyword; drop keywords without 2 comparable months.
      const targets = [];
      const skipped = [];
      for (const k of kws) {
        const pairs = resolvePairs(k.months, mode, params);
        if (!pairs.length) {
          skipped.push(k.keyword);
          continue;
        }
        targets.push({ keyword: k.keyword, pairs });
      }

      if (skipped.length) {
        pushLog(job, {
          level: "warn",
          message: `Skipped ${skipped.length} keyword(s) without two comparable months: ${skipped.join(", ")}`,
        });
      }
      if (!targets.length) {
        job.status = "done";
        job.done = true;
        pushLog(job, { level: "error", message: "No keywords had two comparable months for this comparison." });
        return;
      }

      pushLog(job, {
        level: "info",
        message: `Exporting ${targets.reduce((n, t) => n + t.pairs.length, 0)} comparison image(s) across ${targets.length} keyword(s).`,
      });

      const outDir = path.join(OUTPUT_DIR, job.id);
      fs.mkdirSync(outDir, { recursive: true });

      job.status = "running";
      const { files, errors } = await runExport({
        credentials: { email: session.email, password: session.password },
        business,
        targets,
        outDir,
        headless,
        onProgress: (e) => pushLog(job, e),
      });

      job.files = files;
      job.errors = errors;

      // Write a manifest.
      const manifest = [
        `Map Ranking — Heatmap Comparison Export`,
        `Client: ${business.name}`,
        `Generated: ${new Date().toString()}`,
        `Comparison: ${mode}`,
        ``,
        ...targets.flatMap((t) => t.pairs.map((p) => `${t.keyword}  —  ${pairLabel(p)}  ->  ${require_slug(t.keyword)}__${p.tag}.png`)),
      ].join("\n");
      fs.writeFileSync(path.join(outDir, "manifest.txt"), manifest, "utf8");

      if (files.length) {
        const zipPath = path.join(OUTPUT_DIR, `${job.id}.zip`);
        await zipDirectory(outDir, zipPath);
        job.zipPath = zipPath;
        pushLog(job, { level: "success", message: `Done — ${files.length} image(s) zipped.` });
      } else {
        pushLog(job, { level: "error", message: "No images were captured. Check the debug screenshots in output/." });
      }
      job.status = "done";
      job.done = true;
    } catch (e) {
      job.status = "error";
      job.done = true;
      pushLog(job, { level: "error", message: e instanceof Error ? e.message : String(e) });
    }
  })();
});

// tiny local slug for manifest (avoid importing into template above)
function require_slug(text) {
  return String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

app.get("/api/export/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const since = parseInt(req.query.since, 10) || 0;
  res.json({
    status: job.status,
    done: job.done,
    entries: job.log.slice(since),
    total: job.log.length,
    fileCount: job.files.length,
    errors: job.errors,
    downloadReady: !!job.zipPath,
  });
});

app.get("/api/export/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(404).send("Export not ready.");
  }
  const safe = (job.business?.name || "client").replace(/[^a-z0-9]+/gi, "-");
  res.download(job.zipPath, `heatmaps-${safe}-${job.id}.zip`);
});

app.listen(PORT, () => {
  console.log(`\n  Heatmap Extractor running →  http://localhost:${PORT}\n`);
});
