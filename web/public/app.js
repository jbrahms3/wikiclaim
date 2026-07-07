const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Math.round(n || 0).toLocaleString();
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();

let state = {
  user: null,
  mode: "login",
  me: null,
  trending: [],
  selected: null, // normalized: { kind, article, project, lang, displayTitle, snippet, url, currentPrice, changePct, owned, holdingId, purchasePrice, totalEarned, purchasedDate }
  chartDays: 30,
  chartRequestId: 0,
};

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
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
  state.selected = null;
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

/* ---------- Icon rail: scroll-to-section ---------- */
document.querySelectorAll(".rail-btn[data-scroll]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById(btn.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll(".rail-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

/* ---------- Top stats ---------- */
function renderStats(me) {
  $("#stat-username").textContent = me.user.username;
  $("#stat-avatar").textContent = initials(me.user.username);
  $("#stat-credits").textContent = fmt(me.user.credits);
  $("#stat-networth").textContent = fmt(me.netWorth);
  $("#stat-pages").textContent = me.holdings.length;
}

/* ---------- Ticker strip ---------- */
function renderTicker(items) {
  const el = $("#ticker");
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<span class="ticker-loading">No trending data right now.</span>`;
    return;
  }
  for (const t of items) {
    const up = (t.changePct || 0) >= 0;
    const btn = document.createElement("button");
    btn.className = "ticker-item";
    btn.innerHTML = `
      <span class="ticker-dot">${escapeHtml(initials(t.title))}</span>
      <span class="ticker-name">${escapeHtml(t.title)}</span>
      <span class="ticker-price">${fmt(t.price)}</span>
      <span class="ticker-change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(t.changePct || 0)}%</span>`;
    btn.addEventListener("click", () =>
      selectItem({
        kind: "trending",
        article: t.article,
        project: "en.wikipedia",
        lang: "en",
        displayTitle: t.title,
        snippet: "Trending on WikiClaim's market ticker.",
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.article)}`,
        currentPrice: t.price,
        changePct: t.changePct,
      })
    );
    el.appendChild(btn);
  }
}

async function refreshTrending() {
  try {
    const { items } = await api("/api/trending");
    state.trending = items;
    renderTicker(items);
  } catch {
    renderTicker([]);
  }
}

/* ---------- Selection + hero detail panel ---------- */
function findHolding(article) {
  return (state.me?.holdings || []).find((h) => h.article === article) || null;
}

function selectItem(item) {
  const owned = findHolding(item.article);
  state.selected = {
    ...item,
    owned: !!owned,
    holdingId: owned ? owned.id : null,
    purchasePrice: owned ? owned.purchasePrice : item.purchasePrice ?? null,
    totalEarned: owned ? owned.totalEarned : item.totalEarned ?? null,
    purchasedDate: owned ? owned.purchasedDate : item.purchasedDate ?? null,
    currentPrice: owned ? owned.currentPrice : item.currentPrice,
    changePct: owned ? owned.changePct : item.changePct,
  };
  renderHero();
  loadChart();
  document.querySelectorAll(".card[data-article]").forEach((c) =>
    c.classList.toggle("selected", c.dataset.article === item.article)
  );
}

function renderHero() {
  const sel = state.selected;
  const actionBtn = $("#hero-action");

  if (!sel) {
    $("#hero-icon").textContent = "?";
    $("#hero-title").textContent = "Pick an article";
    $("#hero-sub").textContent = "Search the market or click a trending page to see it here.";
    $("#hero-price").textContent = "—";
    $("#hero-change").textContent = "";
    $("#hero-change").className = "hero-change";
    $("#chart-ticker").textContent = "—";
    actionBtn.textContent = "Select a page";
    actionBtn.disabled = true;
    actionBtn.onclick = null;
    $("#details-list").innerHTML = "";
    return;
  }

  $("#hero-icon").textContent = initials(sel.displayTitle);
  $("#hero-title").innerHTML = `<a href="${sel.url}" target="_blank" rel="noopener">${escapeHtml(sel.displayTitle)}</a>`;
  $("#hero-sub").textContent = sel.snippet || (sel.owned ? "You own this page." : "Not in your portfolio yet.");
  $("#hero-price").textContent = fmt(sel.currentPrice);
  $("#chart-ticker").textContent = sel.article.toUpperCase();

  const changeEl = $("#hero-change");
  if (sel.changePct != null) {
    const up = sel.changePct >= 0;
    changeEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(sel.changePct)}% vs 30d avg`;
    changeEl.className = `hero-change ${up ? "up" : "down"}`;
  } else {
    changeEl.textContent = "";
    changeEl.className = "hero-change";
  }

  const affordable = state.me && sel.currentPrice != null && state.me.user.credits >= sel.currentPrice;
  if (sel.owned) {
    actionBtn.textContent = "Sell this page";
    actionBtn.disabled = false;
    actionBtn.onclick = () => sell(sel.holdingId, sel.displayTitle);
  } else if (!affordable) {
    actionBtn.textContent = `Need ${fmt(sel.currentPrice)} credits`;
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  } else {
    actionBtn.textContent = `Buy for ${fmt(sel.currentPrice)}`;
    actionBtn.disabled = false;
    actionBtn.onclick = () =>
      buy({ article: sel.article, title: sel.displayTitle }, actionBtn);
  }

  renderDetails(sel);
}

function renderDetails(sel) {
  const rows = [
    ["Article", sel.article],
    ["Status", sel.owned ? "Owned" : "Not owned"],
    ["Current price", `${fmt(sel.currentPrice)} views/day`],
  ];
  if (sel.changePct != null) {
    rows.push(["vs 30-day avg", `${sel.changePct >= 0 ? "+" : ""}${sel.changePct}%`, sel.changePct >= 0 ? "up" : "down"]);
  }
  if (sel.owned) {
    rows.push(["Purchase price", fmt(sel.purchasePrice)]);
    const diff = sel.currentPrice - sel.purchasePrice;
    rows.push(["Since purchase", `${diff >= 0 ? "+" : ""}${fmt(diff)}`, diff >= 0 ? "up" : "down"]);
    rows.push(["Total earned", `+${fmt(sel.totalEarned)}`, "up"]);
    rows.push(["Purchased", sel.purchasedDate ? formatShortDate(sel.purchasedDate) : "—"]);
  }

  const dl = $("#details-list");
  dl.innerHTML = rows
    .map(
      ([label, value, cls]) => `
    <div class="details-row">
      <dt>${escapeHtml(label)}</dt>
      <dd${cls ? ` class="${cls}"` : ""}>${escapeHtml(String(value))}</dd>
    </div>`
    )
    .join("");
}

/* ---------- Chart ---------- */
document.querySelectorAll(".range-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.chartDays = Number(tab.dataset.days);
    document.querySelectorAll(".range-tab").forEach((t) => t.classList.toggle("active", t === tab));
    loadChart();
  });
});

async function loadChart() {
  const sel = state.selected;
  const holder = $("#chart-holder");
  if (!sel) {
    holder.innerHTML = `<div class="chart-empty" id="chart-empty">No article selected yet.</div>`;
    return;
  }
  const requestId = ++state.chartRequestId;
  holder.innerHTML = `<div class="chart-empty">Loading chart…</div>`;
  try {
    const { history } = await api(
      `/api/history?article=${encodeURIComponent(sel.article)}&days=${state.chartDays}`
    );
    if (requestId !== state.chartRequestId) return; // stale response, a newer selection/range won
    holder.innerHTML = buildChartSvg(history);
  } catch (err) {
    if (requestId !== state.chartRequestId) return;
    holder.innerHTML = `<div class="chart-empty">Couldn't load chart data.</div>`;
  }
}

function buildChartSvg(history) {
  if (!history.length) return `<div class="chart-empty">No view data available.</div>`;

  const W = 700;
  const H = 240;
  const padL = 42;
  const padR = 10;
  const padT = 14;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = history.map((d) => d.views);
  const maxV = Math.max(1, ...values);
  const minV = 0;
  const n = history.length;

  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v) => padT + innerH - ((v - minV) / (maxV - minV || 1)) * innerH;

  const points = history.map((d, i) => [xAt(i), yAt(d.views)]);

  // Catmull-Rom -> cubic Bezier for a smooth line through daily points.
  function smoothPath(pts) {
    if (pts.length < 2) {
      const [x, y] = pts[0];
      return `M ${x} ${y} L ${x} ${y}`;
    }
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }

  const linePath = smoothPath(points);
  const baseline = padT + innerH;
  const areaPath = `${linePath} L ${points[n - 1][0]} ${baseline} L ${points[0][0]} ${baseline} Z`;

  const gridLines = [0, 0.5, 1]
    .map((t) => {
      const y = padT + innerH * t;
      const val = Math.round(maxV * (1 - t));
      return `<line class="chart-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />
              <text class="chart-axis-label" x="4" y="${y + 3}">${fmt(val)}</text>`;
    })
    .join("");

  const firstDate = formatShortDate(history[0].date);
  const lastDate = formatShortDate(history[n - 1].date);

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#5b5bf0" stop-opacity="0.32" />
          <stop offset="100%" stop-color="#5b5bf0" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" d="${areaPath}" />
      <path class="chart-line" d="${linePath}" />
      <text class="chart-axis-label" x="${padL}" y="${H - 4}">${firstDate}</text>
      <text class="chart-axis-label" x="${W - padR}" y="${H - 4}" text-anchor="end">${lastDate}</text>
    </svg>`;
}

function formatShortDate(yyyymmdd) {
  const y = yyyymmdd.slice(0, 4);
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m]} ${d}`;
}

/* ---------- Holdings & search lists ---------- */
function renderHoldings(me) {
  const list = $("#holdings");
  list.innerHTML = "";
  $("#holdings-empty").hidden = me.holdings.length > 0;

  for (const h of me.holdings) {
    const up = (h.changePct || 0) >= 0;
    const li = document.createElement("li");
    li.className = "card";
    li.dataset.article = h.article;
    li.innerHTML = `
      <span class="card-icon">${escapeHtml(initials(h.displayTitle))}</span>
      <div class="card-main">
        <div class="card-title">${escapeHtml(h.displayTitle)}</div>
        <div class="card-sub">bought at ${fmt(h.purchasePrice)} · earned <span class="earn">+${fmt(h.totalEarned)}</span></div>
      </div>
      <div class="price-tag">
        <span class="price-num">${fmt(h.currentPrice)}</span>
        <small>views/day</small>
        <span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(h.changePct || 0)}%</span>
      </div>
      <button class="sell" data-id="${h.id}">Sell</button>`;
    li.querySelector(".sell").addEventListener("click", (e) => {
      e.stopPropagation();
      sell(h.id, h.displayTitle);
    });
    li.addEventListener("click", () =>
      selectItem({
        kind: "holding",
        article: h.article,
        project: h.project,
        lang: h.lang,
        displayTitle: h.displayTitle,
        snippet: "You own this page.",
        url: h.url,
        currentPrice: h.currentPrice,
        changePct: h.changePct,
      })
    );
    list.appendChild(li);
  }
}

function renderLeaderboard(rows) {
  const ol = $("#leaderboard-list");
  ol.innerHTML = "";
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    const me = state.user && r.username === state.user.username;
    li.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name ${me ? "me" : ""}">${escapeHtml(r.username)}${me ? '<span class="lb-you-badge">You</span>' : ""}</span>
      <span class="lb-pages">${r.pages} pg</span>
      <span class="lb-worth">${fmt(r.netWorth)}</span>`;
    ol.appendChild(li);
  });
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
    const up = (r.changePct || 0) >= 0;
    const li = document.createElement("li");
    li.className = "card";
    li.dataset.article = r.article;
    li.innerHTML = `
      <span class="card-icon">${escapeHtml(initials(r.title))}</span>
      <div class="card-main">
        <div class="card-title">${escapeHtml(r.title)}</div>
        <div class="card-snippet">${escapeHtml(r.snippet)}</div>
      </div>
      <div class="price-tag">
        <span class="price-num">${r.price == null ? "—" : fmt(r.price)}</span>
        <small>views/day</small>
        ${r.price != null ? `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(r.changePct || 0)}%</span>` : ""}
      </div>
      <button class="buy">${isOwned ? "Owned" : "Buy"}</button>`;
    const btn = li.querySelector(".buy");
    btn.disabled = isOwned || !affordable || r.price == null;
    if (!isOwned && !affordable && r.price != null) btn.textContent = "Too pricey";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      buy(r, btn);
    });
    li.addEventListener("click", () =>
      selectItem({
        kind: "search",
        article: r.article,
        project: "en.wikipedia",
        lang: "en",
        displayTitle: r.title,
        snippet: r.snippet,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.article)}`,
        currentPrice: r.price,
        changePct: r.changePct,
      })
    );
    list.appendChild(li);
  }
}

async function buy(r, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Buying…";
  }
  try {
    const res = await api("/api/buy", {
      method: "POST",
      body: JSON.stringify({ article: r.article, displayTitle: r.title }),
    });
    state.me = res.portfolio;
    renderStats(res.portfolio);
    renderHoldings(res.portfolio);
    refreshLeaderboard();
    if (state.selected && state.selected.article === r.article) selectItem(state.selected);
    // Refresh the search list so owned/affordability states update.
    $("#search-form").dispatchEvent(new Event("submit"));
    toast(`Bought "${r.title}" for ${fmt(res.cost)} credits.`);
  } catch (err) {
    toast(err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Buy";
    }
    renderHero();
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
    if (state.selected && state.selected.holdingId === holdingId) selectItem(state.selected);
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
  await refreshTrending();

  if (!state.selected) {
    if (me.holdings.length) {
      const h = me.holdings[0];
      selectItem({
        kind: "holding",
        article: h.article,
        project: h.project,
        lang: h.lang,
        displayTitle: h.displayTitle,
        snippet: "You own this page.",
        url: h.url,
        currentPrice: h.currentPrice,
        changePct: h.changePct,
      });
    } else if (state.trending.length) {
      const t = state.trending[0];
      selectItem({
        kind: "trending",
        article: t.article,
        project: "en.wikipedia",
        lang: "en",
        displayTitle: t.title,
        snippet: "Trending on WikiClaim's market ticker.",
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.article)}`,
        currentPrice: t.price,
        changePct: t.changePct,
      });
    }
  }

  showGame();
}

setMode("login");
loadGame();
