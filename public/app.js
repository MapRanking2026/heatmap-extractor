// Frontend logic for the Heatmap Extractor.

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
});

let clients = [];
let keywords = [];       // current client's keywords with .months
let selectedClient = null;

// ---------- Session ----------
async function refreshSession() {
  const s = await api("/api/session");
  if (s.loggedIn) {
    showApp(s.email);
  } else {
    // Try auto-login with saved creds (no prompt) if any exist.
    if (s.savedCreds) {
      try {
        const r = await api("/api/session/login", { method: "POST", headers: json(), body: "{}" });
        return showApp(r.email);
      } catch {
        /* fall through to login form */
      }
    }
    showLogin();
  }
}

function showLogin() {
  $("loginCard").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("sessionBox").innerHTML = "";
}

function showApp(email) {
  $("loginCard").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("sessionBox").innerHTML = `Signed in as <b>${escapeHtml(email)}</b> · <button id="logoutBtn" class="link">Sign out</button>`;
  $("logoutBtn").onclick = async () => { await api("/api/session/logout", { method: "POST", headers: json(), body: "{}" }); location.reload(); };
  loadClients();
}

$("loginBtn").onclick = async () => {
  $("loginError").textContent = "";
  $("loginBtn").disabled = true;
  try {
    const body = JSON.stringify({
      email: $("email").value.trim(),
      password: $("password").value,
      remember: $("remember").checked,
    });
    const r = await api("/api/session/login", { method: "POST", headers: json(), body });
    showApp(r.email);
  } catch (e) {
    $("loginError").textContent = e.message;
  } finally {
    $("loginBtn").disabled = false;
  }
};

// ---------- Clients ----------
async function loadClients() {
  $("clientMeta").textContent = "Loading clients…";
  try {
    const r = await api("/api/clients");
    clients = r.clients;
    const dl = $("clientList");
    dl.innerHTML = clients.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.address || "")}</option>`).join("");
    $("clientMeta").textContent = `${clients.length} clients in the account.`;
  } catch (e) {
    $("clientMeta").textContent = e.message;
  }
}

$("loadKeywordsBtn").onclick = async () => {
  const name = $("clientSearch").value.trim();
  const client = clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!client) { $("clientMeta").textContent = "Pick a client from the list."; return; }
  selectedClient = client;
  $("clientMeta").textContent = `Loading keywords for ${client.name}…`;
  $("loadKeywordsBtn").disabled = true;
  try {
    const r = await api(`/api/clients/${client.id}/keywords`);
    keywords = r.keywords;
    $("clientMeta").textContent = `${client.name} · ${keywords.length} keyword(s) found.`;
    renderKeywords();
    $("step2").classList.remove("hidden");
    $("step3").classList.remove("hidden");
    updateSummary();
  } catch (e) {
    $("clientMeta").textContent = e.message;
  } finally {
    $("loadKeywordsBtn").disabled = false;
  }
};

// ---------- Keywords ----------
function currentStatus() {
  return document.querySelector('input[name=status]:checked').value;
}
function currentMode() {
  return document.querySelector('input[name=mode]:checked').value;
}

function visibleKeywords() {
  const st = currentStatus();
  return keywords.filter((k) => st === "all" || k.status === st);
}

function renderKeywords() {
  const list = visibleKeywords();
  $("kwCount").textContent = `(${list.length} shown)`;
  $("keywordList").innerHTML = list.map((k) => {
    const canCompare = k.monthCount >= 2;
    return `<label class="kwrow">
      <input type="checkbox" class="kw" value="${escapeHtml(k.keyword)}" ${canCompare ? "checked" : "disabled"} />
      <span class="name">${escapeHtml(k.keyword)}</span>
      <span class="months">${k.monthCount} month(s)${canCompare ? "" : " · not enough to compare"}</span>
      <span class="badge ${k.status}">${k.status}</span>
    </label>`;
  }).join("") || `<div class="muted" style="padding:10px">No keywords match this status.</div>`;
  rebuildMonthPickers();
  updateSummary();
}

function selectedKeywordNames() {
  return [...document.querySelectorAll(".kw:checked")].map((c) => c.value);
}

$("selectAll").onclick = () => { document.querySelectorAll(".kw:not(:disabled)").forEach((c) => (c.checked = true)); updateSummary(); };
$("selectNone").onclick = () => { document.querySelectorAll(".kw").forEach((c) => (c.checked = false)); updateSummary(); };

document.querySelectorAll('input[name=status]').forEach((r) => (r.onchange = renderKeywords));
document.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = () => {
  $("customRange").classList.toggle("hidden", currentMode() !== "custom");
  updateSummary();
}));
$("keywordList").addEventListener("change", updateSummary);

// Build the From/To month <select>s from the union of months across selected keywords.
function rebuildMonthPickers() {
  const names = new Set(selectedKeywordNames().map((s) => s.toLowerCase()));
  const pool = keywords.filter((k) => !names.size || names.has(k.keyword.toLowerCase()));
  const monthMap = new Map(); // key -> label
  for (const k of pool) for (const m of k.months) monthMap.set(m.key, m.monthLabel);
  const months = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const opts = months.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
  $("beforeMonth").innerHTML = opts;
  $("afterMonth").innerHTML = opts;
  if (months.length >= 2) {
    $("beforeMonth").value = months[months.length - 2][0];
    $("afterMonth").value = months[months.length - 1][0];
  }
}

function updateSummary() {
  rebuildMonthPickers();
  const names = selectedKeywordNames();
  const mode = currentMode();
  const modeLabel = {
    current_vs_previous: "this month vs last month",
    since_beginning: "since the beginning → now",
    all_consecutive: "every month-over-month",
    custom: "a custom range",
  }[mode];
  $("exportSummary").textContent = names.length
    ? `Will export ${names.length} keyword(s), ${modeLabel}, as PNGs in a ZIP.`
    : "Select at least one keyword.";
  $("exportBtn").disabled = !names.length;
}

// ---------- Export ----------
$("exportBtn").onclick = async () => {
  const names = selectedKeywordNames();
  if (!names.length) return;
  const mode = currentMode();
  const params = mode === "custom" ? { beforeKey: $("beforeMonth").value, afterKey: $("afterMonth").value } : {};

  $("exportBtn").disabled = true;
  $("progressBox").classList.remove("hidden");
  $("downloadLink").classList.add("hidden");
  $("log").innerHTML = "";

  let jobId;
  try {
    const r = await api("/api/export", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({
        clientId: selectedClient.id,
        keywords: names,
        status: currentStatus(),
        mode,
        params,
        headless: !$("showBrowser").checked,
      }),
    });
    jobId = r.jobId;
  } catch (e) {
    appendLog({ level: "error", message: e.message });
    $("exportBtn").disabled = false;
    return;
  }

  // Poll progress.
  let since = 0;
  const poll = setInterval(async () => {
    try {
      const s = await api(`/api/export/${jobId}?since=${since}`);
      since = s.total;
      s.entries.forEach(appendLog);
      if (s.done) {
        clearInterval(poll);
        $("exportBtn").disabled = false;
        if (s.downloadReady) {
          const dl = $("downloadLink");
          dl.href = `/api/export/${jobId}/download`;
          dl.classList.remove("hidden");
        }
      }
    } catch (e) {
      clearInterval(poll);
      appendLog({ level: "error", message: e.message });
      $("exportBtn").disabled = false;
    }
  }, 1200);
};

function appendLog(entry) {
  const el = document.createElement("div");
  el.className = entry.level || "info";
  el.textContent = entry.message;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
}

// ---------- utils ----------
function json() { return { "content-type": "application/json" }; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

refreshSession();
