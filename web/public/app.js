const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();

const state = {
  user: null,
  me: null,
  categories: [],
  trending: [],
  watchlist: [],
  activity: [],
  leaderboard: [],
  bets: { open: [], resolved: [] },
  predictDirection: null,
  detail: null,
  route: { page: "overview" },
  ovDays: 30,
  detDays: 30,
  moversTab: "trending",
  chartSeq: 0,
};

/* ================= helpers ================= */

// Every API call carries the current Clerk session token as a Bearer header
// (when signed in). getToken() is cheap - Clerk caches the JWT client-side
// and only re-fetches near expiry - so it's fine to call on every request.
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = await window.Clerk?.session?.getToken().catch(() => null);
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { headers, ...opts });
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
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function thumbHtml(item, cls = "thumb") {
  const letter = `<span class="${cls}">${escapeHtml(initials(item.displayTitle || item.title))}</span>`;
  if (!item.thumbnail) return letter;
  // Hidden initials fallback swaps in if the image fails (hotlink blocks, etc.).
  return `<span class="thumb-wrap"><img class="${cls}" src="${escapeHtml(item.thumbnail)}" alt=""
    loading="lazy" referrerpolicy="no-referrer"
    onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"
  /><span class="${cls}" style="display:none">${escapeHtml(initials(item.displayTitle || item.title))}</span></span>`;
}

function badgeHtml(changePct) {
  if (changePct == null) return "";
  const up = changePct >= 0;
  return `<span class="badge ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(changePct)}%</span>`;
}

function sparkSvg(values, changePct) {
  if (!values || values.length < 2) return "";
  const w = 72, h = 24, pad = 2;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const cls = (changePct ?? values[values.length - 1] - values[0]) >= 0 ? "up" : "down";
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}"><polyline class="${cls}" points="${pts}" /></svg>`;
}

function formatShortDate(yyyymmdd) {
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m]} ${d}`;
}

function formatCountdown(resolvesAt) {
  const ms = resolvesAt - Date.now();
  if (ms <= 0) return "Resolving…";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Smooth line + gradient area chart. gradId must be unique per chart slot. */
function bigChartSvg(history, gradId) {
  if (!history || !history.length) return "";
  const W = 720, H = 250, padL = 46, padR = 12, padT = 12, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const values = history.map((d) => d.views);
  const maxV = Math.max(1, ...values);
  const n = history.length;

  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v) => padT + innerH - (v / maxV) * innerH;
  const pts = history.map((d, i) => [xAt(i), yAt(d.views)]);

  function smoothPath(p) {
    if (p.length < 2) return `M ${p[0][0]} ${p[0][1]}`;
    let d = `M ${p[0][0]} ${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6},` +
           ` ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6},` +
           ` ${p2[0]} ${p2[1]}`;
    }
    return d;
  }

  const line = smoothPath(pts);
  const base = padT + innerH;
  const area = `${line} L ${pts[n - 1][0]} ${base} L ${pts[0][0]} ${base} Z`;

  const grid = [0, 0.5, 1]
    .map((t) => {
      const y = padT + innerH * t;
      return `<line class="chart-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />
              <text class="chart-axis-label" x="4" y="${y + 3}">${fmt(maxV * (1 - t))}</text>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3366cc" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#3366cc" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${gradId})" />
      <path class="chart-line" d="${line}" />
      <text class="chart-axis-label" x="${padL}" y="${H - 6}">${formatShortDate(history[0].date)}</text>
      <text class="chart-axis-label" x="${W - padR}" y="${H - 6}" text-anchor="end">${formatShortDate(history[n - 1].date)}</text>
    </svg>`;
}

/* ================= auth (Clerk) ================= */

// The CDN script tag (see index.html <head>) sets window.Clerk once it
// finishes loading, but that can happen after this script runs, so poll
// briefly rather than assuming it's already there.
function waitForClerkScript() {
  return new Promise((resolve, reject) => {
    if (window.Clerk) return resolve(window.Clerk);
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (window.Clerk) {
        clearInterval(timer);
        resolve(window.Clerk);
      } else if (tries > 100) {
        clearInterval(timer);
        reject(new Error("Clerk failed to load."));
      }
    }, 200);
  });
}

function showAuthView() {
  $("#game-view").hidden = true;
  $("#auth-view").hidden = false;
  $("#auth-loading").hidden = true;
  // Mount once; Clerk's widget manages its own sign-in/sign-up toggle internally.
  const mount = $("#clerk-auth");
  if (window.Clerk && mount && !mount.dataset.mounted) {
    window.Clerk.mountSignIn(mount);
    mount.dataset.mounted = "1";
  }
}

async function enterGame() {
  $("#auth-view").hidden = true;
  $("#game-view").hidden = false;
  const signedIn = await loadMe();
  if (!signedIn) {
    // Clerk says signed in but our backend didn't resolve a matching account
    // (e.g. CLERK_SECRET_KEY missing/misconfigured server-side) - fail safe
    // rather than showing a half-loaded game view with no data.
    showAuthView();
    $("#auth-error").textContent =
      "Signed in with Clerk, but the server couldn't verify it. Try again shortly.";
    return;
  }
  loadSecondary();
  if (!location.hash) location.hash = "#/overview";
  renderRoute();
}

async function initClerk() {
  const Clerk = await waitForClerkScript();
  await Clerk.load();
  // Fires immediately with the current state, then again on every sign-in/out.
  Clerk.addListener(({ user }) => {
    if (user) {
      enterGame();
    } else {
      state.user = null;
      state.me = null;
      showAuthView();
    }
  });
}

$("#logout-btn").addEventListener("click", () => window.Clerk?.signOut());

/* ================= data loading ================= */

async function loadMe() {
  const me = await api("/api/me");
  if (!me.user) return false;
  state.user = me.user;
  state.me = me;
  renderChrome();
  return true;
}

function loadSecondary() {
  // Fire-and-forget refreshes; each re-renders its own consumers when done.
  api("/api/categories").then(({ categories }) => {
    state.categories = categories;
    renderTicker();
  }).catch(() => {});
  api("/api/trending").then(({ items }) => {
    state.trending = items;
    if (state.route.page === "overview") renderMovers();
    if (state.route.page === "market" && !state.route.q) renderRoute();
  }).catch(() => {});
  api("/api/watchlist").then(({ items }) => {
    state.watchlist = items;
    if (state.route.page === "overview") renderOvWatchlist();
    if (state.route.page === "watchlist") renderRoute();
  }).catch(() => {});
  api("/api/activity").then(({ events }) => {
    state.activity = events;
    if (state.route.page === "overview") renderOvActivity();
    if (state.route.page === "activity") renderRoute();
  }).catch(() => {});
  api("/api/leaderboard").then(({ rows }) => {
    state.leaderboard = rows;
    if (state.route.page === "leaderboard") renderRoute();
  }).catch(() => {});
  api("/api/bets").then(({ open, resolved }) => {
    state.bets = { open, resolved };
    if (state.route.page === "predictions") renderPredictionsPage();
    if (state.route.page === "article") renderDetOpenBets();
  }).catch(() => {});
}

async function refreshAfterTrade() {
  const me = await api("/api/me");
  state.user = me.user;
  state.me = me;
  renderChrome();
  loadSecondary();
}

/* ================= chrome (sidebar / header) ================= */

function renderChrome() {
  const me = state.me;
  if (!me) return;
  $("#side-credits").textContent = fmt(me.user.credits);
  $("#hdr-networth").textContent = fmt(me.netWorth);
  $("#hdr-today").textContent = `+${fmt(me.todayEarnings)}`;
  $("#hdr-username").textContent = me.user.username;
  $("#hdr-avatar").textContent = initials(me.user.username);
}

function renderTicker() {
  const track = $("#ticker-track");
  if (!state.categories.length) return;

  const tickHtml = state.categories
    .map((c) => {
      const up = (c.changePct || 0) >= 0;
      return `<span class="tick">
        <span class="tick-name">${escapeHtml(c.name)}</span>
        <span class="tick-value">${fmt(c.value)}</span>
        <span class="tick-change ${up ? "pos" : "neg"}">${up ? "+" : ""}${c.changePct}%</span>
        ${sparkSvg(c.spark, c.changePct)}
      </span>`;
    })
    .join("");

  // Duplicate the run so a 0 -> -50% translate loops seamlessly with no gap,
  // and keep speed consistent (not "faster with fewer items") by scaling
  // duration with how many categories there are.
  track.innerHTML = tickHtml + tickHtml;
  track.style.setProperty("--ticker-duration", `${state.categories.length * 4}s`);
}

/* ================= router ================= */

const PAGES = ["overview", "market", "watchlist", "predictions", "leaderboard", "activity", "article"];

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = h.split("?");
  const segs = pathPart.split("/").filter(Boolean);
  const page = segs[0] || "overview";
  const q = new URLSearchParams(queryPart || "");
  if (page === "article" && segs[1]) {
    return { page: "article", article: decodeURIComponent(segs[1]) };
  }
  return PAGES.includes(page)
    ? { page, q: q.get("q") || "" }
    : { page: "overview" };
}

function renderRoute() {
  state.route = parseHash();
  const { page } = state.route;

  document.querySelectorAll(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.dataset.route === page)
  );
  PAGES.forEach((p) => {
    const el = $(`#page-${p}`);
    if (el) el.hidden = p !== page;
  });

  if (page === "overview") renderOverview();
  else if (page === "market") renderMarket();
  else if (page === "watchlist") renderWatchlistPage();
  else if (page === "predictions") renderPredictionsPage();
  else if (page === "leaderboard") renderLeaderboardPage();
  else if (page === "activity") renderActivityPage();
  else if (page === "article") renderArticlePage(state.route.article);
}

window.addEventListener("hashchange", renderRoute);

/* ================= header search ================= */

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  location.hash = `#/market?q=${encodeURIComponent(q)}`;
});

/* ================= overview ================= */

function renderOverview() {
  const me = state.me;
  if (!me) return;

  $("#ov-chart-value").textContent = fmt(me.todayEarnings);

  const rank = me.rank ? `#${me.rank} of ${me.totalPlayers}` : "—";
  $("#metric-stack").innerHTML = [
    ["Portfolio Value", fmt(me.netWorth)],
    ["Wiki Points", fmt(me.user.credits)],
    ["Total Earned", `+${fmt(me.totalEarned)}`],
    ["Today's Earnings", `+${fmt(me.todayEarnings)}`],
    ["Articles Owned", String(me.holdings.length)],
    ["Avg Daily Views", fmt(me.holdingsValue)],
    ["Portfolio Rank", rank],
  ]
    .map(
      ([label, value]) => `
      <div class="metric">
        <span class="metric-label">${label}</span>
        <span class="metric-value">${value}</span>
      </div>`
    )
    .join("");

  renderHoldingsTable();
  renderOvWatchlist();
  renderMovers();
  renderOvActivity();
  loadOverviewChart();
}

function renderHoldingsTable() {
  const me = state.me;
  const tbody = $("#holdings-table tbody");
  $("#holdings-empty").hidden = me.holdings.length > 0;
  $("#holdings-table").hidden = me.holdings.length === 0;

  tbody.innerHTML = "";
  for (const h of me.holdings) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(h)}
          <div>
            <div class="cell-title">${escapeHtml(h.displayTitle)}</div>
            <div class="cell-sub">${escapeHtml(h.description || `since ${formatShortDate(h.purchasedDate)}`)}</div>
          </div>
        </div>
      </td>
      <td class="num">${fmt(h.purchasePrice)}</td>
      <td class="num">${fmt(h.currentPrice)}</td>
      <td class="num">${h.latestViews == null ? "—" : fmt(h.latestViews)}</td>
      <td class="num pos">+${fmt(h.totalEarned)}</td>
      <td>${badgeHtml(h.changePct)}</td>
      <td>${sparkSvg(h.spark, h.changePct)}</td>
      <td><button class="btn-ghost btn-sm">Sell</button></td>`;
    tr.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      sell(h.id, h.displayTitle);
    });
    tr.addEventListener("click", () => openArticle(h.article));
    tbody.appendChild(tr);
  }
}

async function loadOverviewChart() {
  const holder = $("#ov-chart");
  if (!state.me.holdings.length) {
    holder.innerHTML = `<div class="chart-empty">Buy your first article to see your earnings chart.</div>`;
    return;
  }
  const seq = ++state.chartSeq;
  holder.innerHTML = `<div class="chart-empty">Loading…</div>`;
  try {
    const { history } = await api(`/api/portfolio-history?days=${state.ovDays}`);
    if (seq !== state.chartSeq) return;
    holder.innerHTML = history.length
      ? bigChartSvg(history, "gradOverview")
      : `<div class="chart-empty">No readership data yet — check back tomorrow.</div>`;
  } catch {
    if (seq === state.chartSeq)
      holder.innerHTML = `<div class="chart-empty">Couldn't load chart.</div>`;
  }
}

$("#ov-ranges").addEventListener("click", (e) => {
  const tab = e.target.closest(".range-tab");
  if (!tab) return;
  state.ovDays = Number(tab.dataset.days);
  $("#ov-ranges").querySelectorAll(".range-tab").forEach((t) =>
    t.classList.toggle("active", t === tab)
  );
  loadOverviewChart();
});

function miniRow(item) {
  const li = document.createElement("li");
  const up = (item.changePct || 0) >= 0;
  li.innerHTML = `
    ${thumbHtml(item)}
    <div class="mini-main">
      <div class="mini-title">${escapeHtml(item.displayTitle || item.title)}</div>
      <div class="mini-sub">${escapeHtml(item.description || "Wikipedia article")}</div>
    </div>
    <div class="mini-right">
      <div class="mini-price">${item.price == null ? "—" : fmt(item.price)}</div>
      <div class="mini-change ${up ? "pos" : "neg"}">${up ? "+" : ""}${item.changePct ?? 0}%</div>
    </div>`;
  li.addEventListener("click", () => openArticle(item.article));
  return li;
}

function renderOvWatchlist() {
  const ul = $("#ov-watchlist");
  ul.innerHTML = "";
  if (!state.watchlist.length) {
    ul.innerHTML = `<li class="empty">Watch articles to track them here.</li>`;
    return;
  }
  state.watchlist.slice(0, 5).forEach((w) => ul.appendChild(miniRow(w)));
}

function renderMovers() {
  const ul = $("#ov-movers");
  ul.innerHTML = "";
  let items = [...state.trending];
  if (state.moversTab === "gainers") items.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  else if (state.moversTab === "losers") items.sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
  else items.sort((a, b) => (b.price || 0) - (a.price || 0));
  if (!items.length) {
    ul.innerHTML = `<li class="empty">Loading market data…</li>`;
    return;
  }
  items.slice(0, 5).forEach((t) => ul.appendChild(miniRow(t)));
}

$("#movers-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".pill-tab");
  if (!tab) return;
  state.moversTab = tab.dataset.tab;
  $("#movers-tabs").querySelectorAll(".pill-tab").forEach((t) =>
    t.classList.toggle("active", t === tab)
  );
  renderMovers();
});

function feedItemHtml(ev) {
  const title = escapeHtml(ev.displayTitle || "");
  const user = `<b>${escapeHtml(ev.username)}</b>`;
  let dot = "", text = "";
  if (ev.type === "claim") {
    text = `${user} claimed <b>${title}</b> for ${fmt(ev.amount)} pts`;
  } else if (ev.type === "sell") {
    dot = "sell";
    text = `${user} sold <b>${title}</b> for ${fmt(ev.amount)} pts`;
  } else if (ev.type === "join") {
    dot = "join";
    text = `${user} joined WikiMarket`;
  } else if (ev.type === "bet") {
    text = `${user} predicted <b>${title}</b> for ${fmt(ev.amount)} pts`;
  } else if (ev.type === "bet-resolved") {
    dot = ev.amount > 0 ? "" : "sell";
    text = `${user}'s prediction on <b>${title}</b> paid out ${fmt(ev.amount)} pts`;
  } else {
    text = `${user} did something`;
  }
  return `<span class="feed-dot ${dot}"></span>
          <span class="feed-text">${text}</span>
          <span class="feed-time">${relTime(ev.ts)}</span>`;
}

function renderOvActivity() {
  const ul = $("#ov-activity");
  ul.innerHTML = "";
  if (!state.activity.length) {
    ul.innerHTML = `<li class="empty">No market activity yet.</li>`;
    return;
  }
  for (const ev of state.activity.slice(0, 7)) {
    const li = document.createElement("li");
    li.innerHTML = feedItemHtml(ev);
    ul.appendChild(li);
  }
}

/* ================= market ================= */

async function renderMarket() {
  const q = state.route.q || "";
  $("#search-input").value = q;
  $("#market-list-title").textContent = q ? `Results for "${q}"` : "Trending Articles";
  const tbody = $("#market-table tbody");
  $("#market-empty").hidden = true;

  let items;
  if (q) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Searching…</td></tr>`;
    try {
      ({ results: items } = await api(`/api/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    // Ignore stale results if the user navigated away mid-fetch.
    if (state.route.page !== "market" || (state.route.q || "") !== q) return;
  } else {
    items = state.trending;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">Loading trending articles…</td></tr>`;
      return;
    }
  }

  tbody.innerHTML = "";
  if (!items.length) {
    $("#market-empty").hidden = false;
    return;
  }

  const owned = new Set((state.me?.holdings || []).map((h) => h.article));
  for (const r of items) {
    const title = r.title || r.displayTitle;
    const isOwned = owned.has(r.article);
    const affordable = r.price != null && state.me.user.credits >= r.price;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(r)}
          <div>
            <div class="cell-title">${escapeHtml(title)}</div>
            <div class="cell-sub">${escapeHtml(r.description || r.snippet || "")}</div>
          </div>
        </div>
      </td>
      <td class="num">${r.price == null ? "—" : fmt(r.price)}</td>
      <td class="num">${r.latestViews == null ? "—" : fmt(r.latestViews)}</td>
      <td>${badgeHtml(r.changePct)}</td>
      <td>${sparkSvg(r.spark, r.changePct)}</td>
      <td><button class="btn-primary btn-sm"></button></td>`;
    const btn = tr.querySelector("button");
    if (isOwned) {
      btn.textContent = "Owned";
      btn.disabled = true;
    } else if (r.price == null) {
      // Pricing data didn't come back (transient Wikimedia flakiness) —
      // offer a manual re-check instead of a misleading disabled state.
      btn.textContent = "No data — retry";
      btn.disabled = false;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        reprice(r.article, title, btn);
      });
    } else {
      btn.textContent = affordable ? "Claim" : "Too pricey";
      btn.disabled = !affordable;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        buy({ article: r.article, title }, btn);
      });
    }
    tr.addEventListener("click", () => openArticle(r.article));
    tbody.appendChild(tr);
  }
}

/* ================= watchlist page ================= */

function renderWatchlistPage() {
  const tbody = $("#watchlist-table tbody");
  const items = state.watchlist;
  $("#watchlist-empty").hidden = items.length > 0;
  $("#watchlist-table").hidden = items.length === 0;
  tbody.innerHTML = "";
  for (const w of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(w)}
          <div>
            <div class="cell-title">${escapeHtml(w.displayTitle)}</div>
            <div class="cell-sub">${escapeHtml(w.description || "")}</div>
          </div>
        </div>
      </td>
      <td class="num">${w.price == null ? "—" : fmt(w.price)}</td>
      <td>${badgeHtml(w.changePct)}</td>
      <td>${sparkSvg(w.spark, w.changePct)}</td>
      <td><button class="btn-ghost btn-sm">Unwatch</button></td>`;
    tr.querySelector("button").addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleWatch(w.article, w.displayTitle);
    });
    tr.addEventListener("click", () => openArticle(w.article));
    tbody.appendChild(tr);
  }
}

/* ================= predictions page ================= */

function renderPredictionsPage() {
  const open = state.bets.open;
  const resolved = state.bets.resolved;

  const openTbody = $("#bets-open-table tbody");
  $("#bets-open-empty").hidden = open.length > 0;
  $("#bets-open-table").hidden = open.length === 0;
  openTbody.innerHTML = "";
  for (const b of open) {
    const pctChange = (b.currentPrice - b.startPrice) / b.startPrice;
    const signedPct = b.direction === "up" ? pctChange : -pctChange;
    const estPayout = Math.max(0, Math.round(b.stake * (1 + signedPct)));
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(b)}
          <div class="cell-title">${escapeHtml(b.displayTitle)}</div>
        </div>
      </td>
      <td>${b.direction === "up" ? "▲ Up" : "▼ Down"}</td>
      <td class="num">${fmt(b.stake)}</td>
      <td class="num">${fmt(b.startPrice)} → ${fmt(b.currentPrice)}</td>
      <td class="bet-countdown">${formatCountdown(b.resolvesAt)}</td>
      <td class="num ${estPayout >= b.stake ? "pos" : "neg"}">${fmt(estPayout)}</td>`;
    tr.addEventListener("click", () => openArticle(b.article));
    openTbody.appendChild(tr);
  }

  const resolvedTbody = $("#bets-resolved-table tbody");
  $("#bets-resolved-empty").hidden = resolved.length > 0;
  $("#bets-resolved-table").hidden = resolved.length === 0;
  resolvedTbody.innerHTML = "";
  for (const b of resolved) {
    const outcome = b.payout > b.stake ? "up" : b.payout < b.stake ? "down" : "even";
    const outcomeText = outcome === "up" ? "Won" : outcome === "down" ? "Lost" : "Even";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(b)}
          <div class="cell-title">${escapeHtml(b.displayTitle)}</div>
        </div>
      </td>
      <td>${b.direction === "up" ? "▲ Up" : "▼ Down"}</td>
      <td class="num">${fmt(b.stake)}</td>
      <td class="num">${fmt(b.startPrice)} → ${fmt(b.endPrice)}</td>
      <td class="num ${outcome === "even" ? "" : outcome === "up" ? "pos" : "neg"}">${fmt(b.payout)}</td>
      <td class="bet-outcome ${outcome}">${outcomeText}</td>`;
    tr.addEventListener("click", () => openArticle(b.article));
    resolvedTbody.appendChild(tr);
  }
}

/* ================= leaderboard page ================= */

function renderLeaderboardPage() {
  const tbody = $("#leaderboard-table tbody");
  tbody.innerHTML = "";
  state.leaderboard.forEach((r, i) => {
    const isMe = state.user && r.id === state.user.id;
    const tr = document.createElement("tr");
    tr.style.cursor = "default";
    tr.innerHTML = `
      <td class="num">#${i + 1}</td>
      <td>
        <div class="cell-article">
          <span class="thumb" style="border-radius:50%">${escapeHtml(initials(r.username))}</span>
          <div class="cell-title">${escapeHtml(r.username)}${isMe ? ' <span class="badge up">You</span>' : ""}</div>
        </div>
      </td>
      <td class="num">${r.pages}</td>
      <td class="num">${fmt(r.credits)}</td>
      <td class="num">${fmt(r.netWorth)}</td>`;
    tbody.appendChild(tr);
  });
}

/* ================= activity page ================= */

function renderActivityPage() {
  const ul = $("#activity-feed");
  ul.innerHTML = "";
  $("#activity-empty").hidden = state.activity.length > 0;
  for (const ev of state.activity) {
    const li = document.createElement("li");
    li.innerHTML = feedItemHtml(ev);
    ul.appendChild(li);
  }
}

/* ================= article detail ================= */

function openArticle(article) {
  location.hash = `#/article/${encodeURIComponent(article)}`;
}

async function renderArticlePage(article) {
  if (!article) return;
  state.detail = null;
  $("#det-title").textContent = article.replace(/_/g, " ");
  $("#det-desc").textContent = "Loading…";
  $("#det-price").textContent = "—";
  $("#det-change").textContent = "";
  $("#det-change").className = "badge";
  $("#det-stats").innerHTML = "";
  $("#det-thumb").outerHTML = `<span class="thumb xl" id="det-thumb">${escapeHtml(initials(article))}</span>`;
  $("#det-chart").innerHTML = `<div class="chart-empty">Loading chart…</div>`;

  let d;
  try {
    d = await api(`/api/article?article=${encodeURIComponent(article)}`);
  } catch (err) {
    $("#det-desc").textContent = err.message;
    return;
  }
  if (state.route.page !== "article" || state.route.article !== article) return;
  state.detail = d;

  $("#det-title").textContent = d.displayTitle;
  $("#det-desc").textContent = d.description || "Wikipedia article";
  $("#det-price").textContent = d.price == null ? "—" : fmt(d.price);
  if (d.thumbnail) {
    $("#det-thumb").outerHTML = `<img class="thumb xl" id="det-thumb" src="${escapeHtml(d.thumbnail)}" alt=""
      referrerpolicy="no-referrer"
      onerror="this.style.visibility='hidden'" />`;
  }
  const changeEl = $("#det-change");
  if (d.changePct == null) {
    changeEl.className = "badge";
    changeEl.textContent = "";
  } else {
    const up = d.changePct >= 0;
    changeEl.className = `badge ${up ? "up" : "down"}`;
    changeEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(d.changePct)}% vs 30d avg`;
  }

  $("#det-wiki").href = d.url;
  renderDetailActions();
  renderDetailStats();
  loadDetailChart();
  resetPredictForm();
  renderDetOpenBets();
}

function renderDetOpenBets() {
  const ul = $("#det-open-bets");
  const d = state.detail;
  if (!ul || !d) return;
  const mine = state.bets.open.filter((b) => b.article === d.article);
  ul.innerHTML = "";
  for (const b of mine) {
    const winning = (b.direction === "up") === (b.currentPrice >= b.startPrice);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mini-main">
        <div class="mini-title">${b.direction === "up" ? "▲ Up" : "▼ Down"} · staked ${fmt(b.stake)} pts</div>
        <div class="mini-sub">${formatCountdown(b.resolvesAt)} · currently ${winning ? "winning" : "losing"}</div>
      </div>
      <div class="mini-right">
        <div class="mini-price ${winning ? "pos" : "neg"}">${fmt(b.currentPrice)}</div>
        <div class="mini-change">from ${fmt(b.startPrice)}</div>
      </div>`;
    ul.appendChild(li);
  }
}

function renderDetailActions() {
  const d = state.detail;
  if (!d) return;
  const actionBtn = $("#det-action");
  const watchBtn = $("#det-watch");

  if (d.price == null) {
    // No pricing data right now — can't buy or sell without it.
    actionBtn.textContent = "Re-check price";
    actionBtn.disabled = false;
    actionBtn.onclick = () => reprice(d.article, d.displayTitle, actionBtn);
  } else if (d.holding) {
    actionBtn.textContent = `Sell for ${fmt(d.price)} pts`;
    actionBtn.disabled = false;
    actionBtn.onclick = () => sell(d.holding.id, d.displayTitle);
  } else if (state.me.user.credits >= d.price) {
    actionBtn.textContent = `Claim for ${fmt(d.price)} pts`;
    actionBtn.disabled = false;
    actionBtn.onclick = () => buy({ article: d.article, title: d.displayTitle }, actionBtn);
  } else {
    actionBtn.textContent = `Need ${fmt(d.price)} pts`;
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  }

  watchBtn.textContent = d.watched ? "★ Watching" : "☆ Watch";
  watchBtn.classList.toggle("active", d.watched);
  watchBtn.onclick = () => toggleWatch(d.article, d.displayTitle);
}

function renderDetailStats() {
  const d = state.detail;
  const rows = [
    ["Market price", d.price == null ? "—" : `${fmt(d.price)} pts`],
    ["Views (last day)", d.latestViews == null ? "—" : fmt(d.latestViews)],
    ["vs 30-day avg", d.changePct == null ? "—" : `${d.changePct >= 0 ? "+" : ""}${d.changePct}%`],
    ["Status", d.holding ? "In your portfolio" : "Unowned"],
  ];
  if (d.holding) {
    rows.push(["Claimed", formatShortDate(d.holding.purchasedDate)]);
    rows.push(["Claim cost", `${fmt(d.holding.purchasePrice)} pts`]);
    if (d.price != null) {
      const diff = d.price - d.holding.purchasePrice;
      rows.push(["Since claim", `${diff >= 0 ? "+" : ""}${fmt(diff)} pts`]);
    }
    rows.push(["Lifetime earned", `+${fmt(d.holding.totalEarned)} pts`]);
  }
  $("#det-stats").innerHTML = rows
    .map(
      ([k, v]) => `
    <div class="stats-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`
    )
    .join("");
}

async function loadDetailChart() {
  const d = state.detail;
  if (!d) return;
  const holder = $("#det-chart");
  const seq = ++state.chartSeq;
  holder.innerHTML = `<div class="chart-empty">Loading chart…</div>`;
  try {
    const { history } = await api(
      `/api/history?article=${encodeURIComponent(d.article)}&days=${state.detDays}`
    );
    if (seq !== state.chartSeq) return;
    holder.innerHTML = history.length
      ? bigChartSvg(history, "gradDetail")
      : `<div class="chart-empty">No readership data for this article.</div>`;
  } catch {
    if (seq === state.chartSeq)
      holder.innerHTML = `<div class="chart-empty">Couldn't load chart.</div>`;
  }
}

$("#det-ranges").addEventListener("click", (e) => {
  const tab = e.target.closest(".range-tab");
  if (!tab) return;
  state.detDays = Number(tab.dataset.days);
  $("#det-ranges").querySelectorAll(".range-tab").forEach((t) =>
    t.classList.toggle("active", t === tab)
  );
  loadDetailChart();
});

/* ================= actions ================= */

async function buy(r, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Claiming…";
  }
  try {
    const res = await api("/api/buy", {
      method: "POST",
      body: JSON.stringify({ article: r.article, displayTitle: r.title }),
    });
    toast(`Claimed "${r.title}" for ${fmt(res.cost)} pts.`);
    await refreshAfterTrade();
    if (state.route.page === "article" && state.detail?.article === r.article) {
      renderArticlePage(r.article);
    } else {
      renderRoute();
    }
  } catch (err) {
    toast(err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Claim";
    }
  }
}

async function sell(holdingId, title) {
  try {
    const res = await api("/api/sell", {
      method: "POST",
      body: JSON.stringify({ holdingId }),
    });
    toast(`Sold "${title}" for ${fmt(res.proceeds)} pts.`);
    await refreshAfterTrade();
    if (state.route.page === "article" && state.detail) {
      renderArticlePage(state.detail.article);
    } else {
      renderRoute();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function reprice(article, title, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    const res = await api("/api/reprice", {
      method: "POST",
      body: JSON.stringify({ article }),
    });
    if (res.price == null) {
      toast("Still no data from Wikimedia for this article — try again shortly.", true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "No data — retry";
      }
      return;
    }
    toast(`"${title}" priced at ${fmt(res.price)} pts.`);
    // Re-render whatever view we're on so the fresh price shows everywhere.
    if (state.route.page === "article" && state.detail?.article === article) {
      renderArticlePage(article);
    } else {
      renderRoute();
    }
  } catch (err) {
    toast(err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "No data — retry";
    }
  }
}

function updatePredictSubmitState() {
  const stakeEl = $("#predict-stake");
  if (!stakeEl) return;
  const stake = Number(stakeEl.value);
  const valid = !!state.predictDirection && Number.isFinite(stake) && stake >= 1;
  $("#predict-submit").disabled = !valid;
}

function resetPredictForm() {
  state.predictDirection = null;
  const stakeEl = $("#predict-stake");
  if (stakeEl) stakeEl.value = "";
  $("#predict-error").textContent = "";
  document.querySelectorAll(".dir-btn").forEach((b) => b.classList.remove("active"));
  updatePredictSubmitState();
}

$("#predict-up").addEventListener("click", () => {
  state.predictDirection = "up";
  $("#predict-up").classList.add("active");
  $("#predict-down").classList.remove("active");
  updatePredictSubmitState();
});
$("#predict-down").addEventListener("click", () => {
  state.predictDirection = "down";
  $("#predict-down").classList.add("active");
  $("#predict-up").classList.remove("active");
  updatePredictSubmitState();
});
$("#predict-stake").addEventListener("input", updatePredictSubmitState);

$("#predict-submit").addEventListener("click", async () => {
  const d = state.detail;
  if (!d) return;
  const stake = Number($("#predict-stake").value);
  const direction = state.predictDirection;
  const btn = $("#predict-submit");
  const errEl = $("#predict-error");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Placing…";
  try {
    const res = await api("/api/bet", {
      method: "POST",
      body: JSON.stringify({ article: d.article, displayTitle: d.displayTitle, direction, stake }),
    });
    state.bets = res.bets;
    state.me = res.portfolio;
    state.user = res.portfolio.user;
    renderChrome();
    toast(`Predicted "${d.displayTitle}" will go ${direction} — staked ${fmt(stake)} pts.`);
    resetPredictForm();
    renderDetOpenBets();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.textContent = "Place Prediction";
    updatePredictSubmitState();
  }
});

async function toggleWatch(article, displayTitle) {
  try {
    const { watched } = await api("/api/watchlist/toggle", {
      method: "POST",
      body: JSON.stringify({ article, displayTitle }),
    });
    toast(watched ? `Watching "${displayTitle}".` : `Removed "${displayTitle}" from watchlist.`);
    if (state.detail?.article === article) {
      state.detail.watched = watched;
      renderDetailActions();
    }
    const { items } = await api("/api/watchlist");
    state.watchlist = items;
    if (state.route.page === "overview") renderOvWatchlist();
    if (state.route.page === "watchlist") renderWatchlistPage();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================= boot ================= */

initClerk().catch((err) => {
  console.error(err);
  $("#auth-loading").textContent = "Couldn't load sign-in — please refresh the page.";
});
