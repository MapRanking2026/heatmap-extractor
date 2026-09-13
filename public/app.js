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

function latestComparableKeywords(list) {
  return list.filter((k) => k.status === "active" && k.monthCount >= 2);
}

// ---------- Session ----------
async function refreshSession() {
  const s = await api("/api/session");
  if (s.loggedIn) {
    showApp(s.email);
  } else {
    if (s.savedCreds) {
      try {
        const r = await api("/api/session/restore", { method: "POST", headers: json(), body: "{}" });
        return showApp(r.email);
      } catch {
        showLogin("Saved login expired. Sign in once to refresh it.");
        return;
      }
    }
    showLogin();
  }
}

function showLogin(message = "") {
  $("loginCard").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("sessionBox").innerHTML = "";
  $("loginError").textContent = message;
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
    $("clientMeta").textContent = `${clients.length} clients ready. Pick one and export the latest comparisons.`;
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
    const ready = latestComparableKeywords(keywords);
    $("clientMeta").textContent = `${client.name} · ${ready.length} active keyword(s) ready for latest comparisons.`;
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
function visibleKeywords() {
  return latestComparableKeywords(keywords);
}

function renderKeywords() {
  const list = visibleKeywords();
  $("kwCount").textContent = `(${list.length} shown)`;
  $("keywordList").innerHTML = list.map((k) => {
    return `<label class="kwrow">
      <input type="checkbox" class="kw" value="${escapeHtml(k.keyword)}" checked />
      <span class="name">${escapeHtml(k.keyword)}</span>
      <span class="months">Latest: ${escapeHtml(k.months[k.months.length - 2].monthLabel)} → ${escapeHtml(k.months[k.months.length - 1].monthLabel)}</span>
      <span class="badge ready">ready</span>
    </label>`;
  }).join("") || `<div class="muted" style="padding:10px">No active keywords have two completed scans yet.</div>`;
  updateSummary();
}

function selectedKeywordNames() {
  return [...document.querySelectorAll(".kw:checked")].map((c) => c.value);
}

$("selectAll").onclick = () => { document.querySelectorAll(".kw:not(:disabled)").forEach((c) => (c.checked = true)); updateSummary(); };
$("selectNone").onclick = () => { document.querySelectorAll(".kw").forEach((c) => (c.checked = false)); updateSummary(); };

$("keywordList").addEventListener("change", updateSummary);

function updateSummary() {
  const names = selectedKeywordNames();
  $("exportSummary").textContent = names.length
    ? `Will export the latest current-vs-previous comparison for ${names.length} active keyword(s).`
    : "Select at least one active keyword.";
  $("exportBtn").disabled = !names.length;
}

// ---------- Export ----------
$("exportBtn").onclick = async () => {
  const names = selectedKeywordNames();
  if (!names.length) return;

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
        status: "active",
        mode: "current_vs_previous",
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
