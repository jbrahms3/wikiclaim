const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Math.round(n || 0).toLocaleString();

let state = { user: null, mode: "login", me: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3000);
}

/* ---------- Auth view ---------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === mode)
  );
  $("#auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("#password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-error").textContent = "";
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => setMode(tab.dataset.tab))
);

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#username").value.trim();
  const password = $("#password").value;
  const btn = $("#auth-submit");
  btn.disabled = true;
  $("#auth-error").textContent = "";
  try {
    await api(`/api/${state.mode}`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    await loadGame();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  showAuth();
});

/* ---------- View switching ---------- */
function showAuth() {
  $("#game-view").hidden = true;
  $("#auth-view").hidden = false;
}
function showGame() {
  $("#auth-view").hidden = true;
  $("#game-view").hidden = false;
}

/* ---------- Game rendering ---------- */
function renderStats(me) {
  $("#stat-username").textContent = me.user.username;
  $("#stat-credits").textContent = fmt(me.user.credits);
  $("#stat-networth").textContent = fmt(me.netWorth);
  $("#stat-pages").textContent = me.holdings.length;
}

function renderHoldings(me) {
  const list = $("#holdings");
  list.innerHTML = "";
  $("#holdings-empty").hidden = me.holdings.length > 0;

  for (const h of me.holdings) {
    const change = h.currentPrice - h.purchasePrice;
    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `
      <div class="card-main">
        <div class="card-title"><a href="${h.url}" target="_blank" rel="noopener">${escapeHtml(h.displayTitle)}</a></div>
        <div class="card-sub">
          bought at ${fmt(h.purchasePrice)} ·
          <span class="${change >= 0 ? "earn" : ""}" style="${change < 0 ? "color:var(--red)" : ""}">
            ${change >= 0 ? "▲" : "▼"} ${fmt(Math.abs(change))}
          </span>
          · earned <span class="earn">+${fmt(h.totalEarned)}</span>
        </div>
      </div>
      <div class="price-tag">${fmt(h.currentPrice)}<small>views/day</small></div>
      <button class="sell" data-id="${h.id}">Sell</button>`;
    li.querySelector(".sell").addEventListener("click", () => sell(h.id, h.displayTitle));
    list.appendChild(li);
  }
}

function renderLeaderboard(rows) {
  const ol = $("#leaderboard");
  ol.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    const me = state.user && r.username === state.user.username;
    li.innerHTML = `
      <span class="lb-name ${me ? "me" : ""}">${escapeHtml(r.username)}</span>
      <span class="lb-pages">${r.pages} pg</span>
      <span class="lb-worth">${fmt(r.netWorth)}</span>`;
    ol.appendChild(li);
  }
}

/* ---------- Actions ---------- */
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  const list = $("#search-results");
  list.innerHTML = `<li class="empty">Searching…</li>`;
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    renderSearch(results);
  } catch (err) {
    list.innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
  }
});

function renderSearch(results) {
  const list = $("#search-results");
  list.innerHTML = "";
  if (!results.length) {
    list.innerHTML = `<li class="empty">No articles found.</li>`;
    return;
  }
  const owned = new Set((state.me?.holdings || []).map((h) => h.article));
  for (const r of results) {
    const isOwned = owned.has(r.article);
    const affordable = state.me && r.price != null && state.me.user.credits >= r.price;
    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `
      <div class="card-main">
        <div class="card-title"><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(r.article)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></div>
        <div class="card-snippet">${escapeHtml(r.snippet)}</div>
      </div>
      <div class="price-tag">${r.price == null ? "—" : fmt(r.price)}<small>views/day</small></div>
      <button class="buy">${isOwned ? "Owned" : "Buy"}</button>`;
    const btn = li.querySelector(".buy");
    btn.disabled = isOwned || !affordable || r.price == null;
    if (!isOwned && !affordable && r.price != null) btn.textContent = "Too pricey";
    btn.addEventListener("click", () => buy(r, btn));
    list.appendChild(li);
  }
}

async function buy(r, btn) {
  btn.disabled = true;
  btn.textContent = "Buying…";
  try {
    const res = await api("/api/buy", {
      method: "POST",
      body: JSON.stringify({ article: r.article, displayTitle: r.title }),
    });
    state.me = res.portfolio;
    renderStats(res.portfolio);
    renderHoldings(res.portfolio);
    refreshLeaderboard();
    // Refresh the search list so owned/affordability states update.
    $("#search-form").dispatchEvent(new Event("submit"));
    toast(`Bought "${r.title}" for ${fmt(res.cost)} credits.`);
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = "Buy";
  }
}

async function sell(holdingId, title) {
  try {
    const res = await api("/api/sell", {
      method: "POST",
      body: JSON.stringify({ holdingId }),
    });
    state.me = res.portfolio;
    renderStats(res.portfolio);
    renderHoldings(res.portfolio);
    refreshLeaderboard();
    toast(`Sold "${title}" for ${fmt(res.proceeds)} credits.`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshLeaderboard() {
  try {
    const { rows } = await api("/api/leaderboard");
    renderLeaderboard(rows);
  } catch {}
}

/* ---------- Boot ---------- */
async function loadGame() {
  const me = await api("/api/me");
  if (!me.user) {
    showAuth();
    return;
  }
  state.user = me.user;
  state.me = me;
  renderStats(me);
  renderHoldings(me);
  refreshLeaderboard();
  showGame();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

setMode("login");
loadGame();
