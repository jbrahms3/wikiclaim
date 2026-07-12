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
  listings: [],
  discover: [],
  discoverCategory: null, // set below once DISCOVER_CATEGORIES exists (defaults to "Random")
  discoverSeq: 0,
  discoverSuggestSeq: 0,
  predictDirection: null,
  detail: null,
  route: { page: "overview" },
  ovDays: 30,
  detDays: 30,
  moversTab: "trending",
  marketTab: "primary",
  chartSeq: 0,
  changeBasis: "daily", // "daily" | "30d" | "year" - which baseline the Change % columns compare against
};

// Field name + labels for each change-% baseline an item carries.
const CHANGE_BASIS = {
  daily: { field: "changePct", short: "1D", suffix: "vs yesterday", statLabel: "Vs yesterday" },
  "30d": { field: "changePct30d", short: "30D", suffix: "vs 30-day avg", statLabel: "Vs 30-day avg" },
  year: { field: "changePctYear", short: "1Y", suffix: "vs yearly avg", statLabel: "Vs yearly avg" },
};

// Every priced item carries all three change-% figures already (no extra
// fetch needed) - this just picks the one matching the current toggle.
function pickChangePct(item) {
  return item[CHANGE_BASIS[state.changeBasis].field];
}

// Curated starting points for category browsing - real Wikipedia category
// names (value: null means "Random", handled separately via /api/discover
// with no ?category=). getCategoryMembers uses the `deepcat:` search
// operator, which recursively pulls in subcategories - so these can be the
// broad, obvious topic names. Two exceptions: "Sports" and "History" hit
// CirrusSearch's recursion-safety limit (their subcategory trees are too
// large/complex to expand) and silently return almost nothing, so those two
// use a still-broad but slightly narrower substitute instead.
const DISCOVER_CATEGORIES = [
  { label: "Random", value: null },
  { label: "Science", value: "Science" },
  { label: "Technology", value: "Technology" },
  { label: "History", value: "World history" },
  { label: "Film & TV", value: "Film" },
  { label: "Music", value: "Music" },
  { label: "Video Games", value: "Video games" },
  { label: "Sports", value: "Team sports" },
  { label: "Geography", value: "Geography" },
];
state.discoverCategory = DISCOVER_CATEGORIES[0];

/* ================= helpers ================= */

// Every API call carries the current Clerk session token as a Bearer header
// (when signed in). getToken() is cheap - Clerk caches the JWT client-side
// and only re-fetches near expiry - so it's fine to call on every request.
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  let token = null;
  try {
    token = (await window.Clerk?.session?.getToken()) ?? null;
  } catch (e) {
    // A failed getToken() would otherwise silently look like "signed out".
    console.warn("Clerk getToken() failed:", e);
  }
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

// Wikimedia hasn't published the latest day's numbers yet (its 1-day lag
// isn't perfectly exact) - approximate "when" as the next UTC day boundary,
// which is roughly when a new day's data starts becoming available.
function resultsInText() {
  const now = Date.now();
  const nextUTCMidnight = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() + 1
  );
  const ms = nextUTCMidnight - now;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `Results in ${h}h ${m}m`;
}

function badgeHtml(changePct, pendingLatest) {
  if (pendingLatest) return `<span class="badge pending">${resultsInText()}</span>`;
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

// Browsing never requires sign-in. These just reflect the current sign-in
// state into the header/sidebar chrome and whichever page is showing -
// nothing here blocks navigation or rendering.
function renderAuthChrome() {
  const signedIn = !!state.user;
  $("#hdr-networth-stat").hidden = !signedIn;
  $("#hdr-today-stat").hidden = !signedIn;
  $("#hdr-profile").hidden = !signedIn;
  $("#hdr-signin-btn").hidden = signedIn;
  $("#sidebar-points-card").hidden = !signedIn;
  $("#logout-btn").hidden = !signedIn;
  $("#sidebar-signedout-card").hidden = signedIn;
  $("#sidebar-signin-btn").hidden = signedIn;
}

// Gate for any action that needs an account (buy, sell, list, predict,
// watch...). Opens Clerk's sign-in modal on demand instead of a full-page
// gate - browsing works with no account at all. Returns whether the caller
// can proceed right now.
function ensureSignedIn() {
  if (state.user) return true;
  window.Clerk?.openSignIn({});
  return false;
}

let signingIn = false;
async function signInSucceeded() {
  if (signingIn) return; // the Clerk listener can fire repeatedly; don't stack
  signingIn = true;
  try {
    const ok = await loadMe();
    renderAuthChrome();
    if (!ok) {
      // Clerk session exists but the backend didn't resolve a matching
      // account (CLERK_SECRET_KEY missing/misconfigured server-side).
      // Browsing still works either way; only account actions would fail.
      toast("Signed in, but the server couldn't verify it — see the console.", true);
      window.api = api; // expose for manual re-runs in the console
      try {
        const diag = await api("/api/debug/auth");
        console.log("[WikiPicks auth diagnostic] full report:", diag);
        const hint = {
          "no-token": "The browser isn't sending a Clerk token. getToken() likely returned null - check window.Clerk.session is non-null.",
          "no-secret-key": "The server has no CLERK_SECRET_KEY set. Add it in Railway -> your service -> Variables, then redeploy.",
          "rejected": "The token was rejected by Clerk - almost always because CLERK_SECRET_KEY belongs to a DIFFERENT Clerk app than the publishable key in index.html. Make sure both keys are from the same Clerk application.",
          "threw": "Clerk threw during verification - usually a malformed/incorrect CLERK_SECRET_KEY.",
          "no-sub": "Token verified but had no user id - unexpected; report this.",
        }[diag.reason];
        // Everything in one line - reason, likely cause, and the raw payload -
        // so copy-pasting just this one line to me is enough to diagnose it.
        console.warn(
          `[WikiPicks auth diagnostic] reason="${diag.reason}"` +
            (hint ? ` likelyCause="${hint}"` : "") +
            (diag.detail ? ` detail=${diag.detail}` : "") +
            ` secretKeyConfigured=${diag.secretKeyConfigured} secretKeyPrefix=${diag.secretKeyPrefix} tokenLength=${diag.tokenLength}`
        );
      } catch (e) {
        console.error("[WikiPicks auth diagnostic] failed to reach /api/debug/auth:", e);
      }
      return;
    }
    loadSecondary();
    renderRoute();
  } finally {
    signingIn = false;
  }
}

async function initClerk() {
  const Clerk = await waitForClerkScript();
  await Clerk.load();
  // The listener fires immediately with current state, then again on every
  // resource change (including periodic token refreshes). Dedupe on the user
  // id so we only react to actual sign-in/out transitions.
  let lastUserId = "__init__";
  Clerk.addListener(({ user }) => {
    const id = user?.id ?? null;
    if (id === lastUserId) return;
    lastUserId = id;
    if (user) {
      signInSucceeded();
    } else {
      state.user = null;
      state.me = null;
      renderAuthChrome();
      renderRoute(); // re-render the current page in its signed-out form
    }
  });
}

$("#logout-btn").addEventListener("click", () => window.Clerk?.signOut());
$("#hdr-signin-btn").addEventListener("click", ensureSignedIn);
$("#sidebar-signin-btn").addEventListener("click", ensureSignedIn);
$("#ov-signin-btn").addEventListener("click", ensureSignedIn);
$("#points-signin-btn").addEventListener("click", ensureSignedIn);
$("#watchlist-signin-btn").addEventListener("click", ensureSignedIn);
$("#predictions-signin-btn").addEventListener("click", ensureSignedIn);

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
  api("/api/activity").then(({ events }) => {
    state.activity = events;
    if (state.route.page === "overview") renderOvActivity();
    if (state.route.page === "activity") renderRoute();
  }).catch(() => {});
  api("/api/leaderboard").then(({ rows }) => {
    state.leaderboard = rows;
    if (state.route.page === "leaderboard") renderRoute();
  }).catch(() => {});
  loadListings();

  // Personal data only exists for a signed-in account.
  if (state.user) {
    api("/api/watchlist").then(({ items }) => {
      state.watchlist = items;
      if (state.route.page === "overview") renderOvWatchlist();
      if (state.route.page === "watchlist") renderRoute();
    }).catch(() => {});
    api("/api/bets").then(({ open, resolved }) => {
      state.bets = { open, resolved };
      if (state.route.page === "predictions") renderPredictionsPage();
      if (state.route.page === "article") renderDetOpenBets();
    }).catch(() => {});
  } else {
    state.watchlist = [];
    state.bets = { open: [], resolved: [] };
  }
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

const PAGES = ["overview", "points", "market", "discover", "watchlist", "predictions", "leaderboard", "activity", "article"];

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
  closeMobileNav();

  document.querySelectorAll(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.dataset.route === page)
  );
  PAGES.forEach((p) => {
    const el = $(`#page-${p}`);
    if (el) el.hidden = p !== page;
  });

  if (page === "overview") renderOverview();
  else if (page === "points") renderPointsPage();
  else if (page === "market") renderMarket();
  else if (page === "discover") renderDiscoverPage();
  else if (page === "watchlist") renderWatchlistPage();
  else if (page === "predictions") renderPredictionsPage();
  else if (page === "leaderboard") renderLeaderboardPage();
  else if (page === "activity") renderActivityPage();
  else if (page === "article") renderArticlePage(state.route.article);
}

window.addEventListener("hashchange", renderRoute);

/* ================= mobile nav drawer ================= */

function closeMobileNav() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-backdrop").classList.remove("open");
  $("#mobile-menu-btn").setAttribute("aria-expanded", "false");
}
function openMobileNav() {
  $("#sidebar").classList.add("open");
  $("#sidebar-backdrop").classList.add("open");
  $("#mobile-menu-btn").setAttribute("aria-expanded", "true");
}
$("#mobile-menu-btn").addEventListener("click", () => {
  $("#sidebar").classList.contains("open") ? closeMobileNav() : openMobileNav();
});
$("#sidebar-backdrop").addEventListener("click", closeMobileNav);

/* ================= header search ================= */

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  location.hash = `#/market?q=${encodeURIComponent(q)}`;
});

/* ================= change-basis toggle ================= */

function updateChangeHeaders() {
  const label = `Change (${CHANGE_BASIS[state.changeBasis].short})`;
  for (const id of ["market-change-th", "discover-change-th", "watchlist-change-th", "holdings-change-th"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  }
}
updateChangeHeaders();

$("#change-basis-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".cb-opt");
  if (!btn || btn.classList.contains("active")) return;
  state.changeBasis = btn.dataset.basis;
  $("#change-basis-toggle").querySelectorAll(".cb-opt").forEach((b) =>
    b.classList.toggle("active", b === btn)
  );
  updateChangeHeaders();
  // Every item already carries all three change-% figures - just re-render
  // whatever's currently showing with the new one, no re-fetch needed.
  renderRoute();
});

/* ================= overview ================= */

function renderOverview() {
  const me = state.me;
  $("#ov-signedout").hidden = !!me;
  $("#ov-content").hidden = !me;

  // These sections are public data - render regardless of sign-in.
  renderMovers();
  renderOvActivity();
  renderOvWatchlist();

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
      <td>${badgeHtml(pickChangePct(h), h.pendingLatest)}</td>
      <td>${sparkSvg(h.spark, pickChangePct(h))}</td>
      <td class="holding-actions"></td>`;
    const actionsTd = tr.querySelector(".holding-actions");
    if (h.listing) {
      actionsTd.innerHTML = `<span class="listed-tag">Listed ${fmt(h.listing.askPrice)}</span><button class="btn-ghost btn-sm">Cancel</button>`;
      actionsTd.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        cancelListingAction(h.id, h.displayTitle);
      });
    } else {
      actionsTd.innerHTML = `<button class="btn-ghost btn-sm">Sell</button><button class="btn-ghost btn-sm">List</button>`;
      const [sellBtn, listBtn] = actionsTd.querySelectorAll("button");
      sellBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sell(h.id, h.displayTitle);
      });
      listBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        listHolding(h.id, h.displayTitle, h.currentPrice);
      });
    }
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
  const cp = pickChangePct(item);
  const up = (cp || 0) >= 0;
  const changeHtml = item.pendingLatest
    ? `<div class="mini-change">${resultsInText()}</div>`
    : `<div class="mini-change ${up ? "pos" : "neg"}">${up ? "+" : ""}${cp ?? 0}%</div>`;
  li.innerHTML = `
    ${thumbHtml(item)}
    <div class="mini-main">
      <div class="mini-title">${escapeHtml(item.displayTitle || item.title)}</div>
      <div class="mini-sub">${escapeHtml(item.description || "Wikipedia article")}</div>
    </div>
    <div class="mini-right">
      <div class="mini-price">${item.price == null ? "—" : fmt(item.price)}</div>
      ${changeHtml}
    </div>`;
  li.addEventListener("click", () => openArticle(item.article));
  return li;
}

function renderOvWatchlist() {
  const ul = $("#ov-watchlist");
  ul.innerHTML = "";
  if (!state.user) {
    ul.innerHTML = `<li class="empty">Sign in to build a watchlist.</li>`;
    return;
  }
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
  // No "losers" tab: Wikimedia's pageviews API has no top-decliners metric,
  // and computing real ones would mean diffing per-article time series
  // across a huge swath of Wikipedia - not feasible from this candidate pool.
  if (state.moversTab === "gainers") items.sort((a, b) => (pickChangePct(b) || 0) - (pickChangePct(a) || 0));
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
    text = `${user} joined WikiPicks`;
  } else if (ev.type === "bet") {
    text = `${user} predicted <b>${title}</b> for ${fmt(ev.amount)} pts`;
  } else if (ev.type === "bet-resolved") {
    dot = ev.amount > 0 ? "" : "sell";
    text = `${user}'s prediction on <b>${title}</b> paid out ${fmt(ev.amount)} pts`;
  } else if (ev.type === "resale") {
    text = `${user} bought <b>${title}</b> on the secondary market for ${fmt(ev.amount)} pts`;
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

/* ================= points ================= */

// Groups earning events (irregular timestamps, one lump per lazy settlement
// catch-up) into calendar-day totals so they can drive the same big-chart
// component the Overview/Article pages use.
function bucketEarningsByDay(history) {
  const totals = new Map();
  for (const ev of history) {
    const d = new Date(ev.ts);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    totals.set(key, (totals.get(key) || 0) + (ev.amount || 0));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, views]) => ({ date, views }));
}

function updateProgressBar(credits, goal) {
  const pct = Math.min(100, (credits / goal) * 100);
  const fill = $("#pts-progress-fill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("goal-reached", credits >= goal);
  $("#pts-progress-current").textContent = `${fmt(credits)} pts`;
  $("#pts-progress-footer").textContent =
    credits >= goal
      ? "🎉 You've passed 1,000,000 points — you've earned a $100 gift card!"
      : `${pct < 1 ? pct.toFixed(2) : Math.round(pct)}% of the way to 1,000,000 pts`;
}

async function renderPointsPage() {
  $("#points-signedout").hidden = !!state.user;
  $("#points-content").hidden = !state.user;
  if (!state.user) return;

  if (state.me) $("#pts-balance").textContent = fmt(state.me.user.credits);

  const holder = $("#pts-chart");
  const tbody = $("#points-history-table tbody");
  holder.innerHTML = `<div class="chart-empty">Loading…</div>`;
  tbody.innerHTML = `<tr><td colspan="4" class="empty">Loading…</td></tr>`;

  let data;
  try {
    data = await api("/api/points");
  } catch (err) {
    holder.innerHTML = `<div class="chart-empty">Couldn't load points.</div>`;
    tbody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (state.route.page !== "points") return;

  $("#pts-balance").textContent = fmt(data.credits);
  updateProgressBar(data.credits, data.goal);

  const series = bucketEarningsByDay(data.history);
  const total = series.reduce((s, d) => s + d.views, 0);
  $("#pts-chart-value").textContent = `+${fmt(total)}`;
  holder.innerHTML = series.length
    ? bigChartSvg(series, "gradPoints")
    : `<div class="chart-empty">No earnings yet — buy an article to start earning.</div>`;

  $("#points-history-empty").hidden = data.history.length > 0;
  $("#points-history-table").hidden = data.history.length === 0;
  tbody.innerHTML = "";
  for (const ev of data.history) {
    const source = ev.type === "bet-resolved" ? "Prediction payout" : "Daily earnings";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(ev)}
          <div class="cell-title">${escapeHtml(ev.displayTitle || "")}</div>
        </div>
      </td>
      <td>${source}</td>
      <td class="muted">${relTime(ev.ts)}</td>
      <td class="num pos">+${fmt(ev.amount)}</td>`;
    if (ev.article) tr.addEventListener("click", () => openArticle(ev.article));
    tbody.appendChild(tr);
  }
}

/* ================= market ================= */

function setMarketTab(tab) {
  state.marketTab = tab;
  $("#market-tabs").querySelectorAll(".pill-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  $("#market-primary-panel").hidden = tab !== "primary";
  $("#market-secondary-panel").hidden = tab !== "secondary";
  $("#market-page-hint").hidden = tab !== "primary";
}

$("#market-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".pill-tab");
  if (!tab) return;
  setMarketTab(tab.dataset.tab);
});

/* ================= discover ================= */

function renderDiscoverCategoryChips() {
  $("#discover-categories").innerHTML = DISCOVER_CATEGORIES.map(
    (c) =>
      `<button class="pill-tab${c.value === state.discoverCategory.value ? " active" : ""}" data-value="${escapeHtml(c.value || "")}">${escapeHtml(c.label)}</button>`
  ).join("");
}

function selectDiscoverCategory(cat) {
  state.discoverCategory = cat;
  renderDiscoverCategoryChips();
  fetchDiscover();
}

$("#discover-categories").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill-tab");
  if (!btn) return;
  const cat = DISCOVER_CATEGORIES.find((c) => (c.value || "") === btn.dataset.value);
  $("#discover-category-input").value = ""; // a curated chip overrides any typed custom search
  selectDiscoverCategory(cat);
});

$("#discover-shuffle-btn").addEventListener("click", () => fetchDiscover());

// Custom category search: debounced live suggestions from real Wikipedia
// category names (English Wikipedia has ~2.4M categories - far too many to
// list, and deepcat: needs an exact title, so this is how anything beyond
// the curated chips above gets found).
let discoverSuggestTimer = null;
const discoverCategoryInput = $("#discover-category-input");
const discoverSuggestionsEl = $("#discover-suggestions");

discoverCategoryInput.addEventListener("input", () => {
  clearTimeout(discoverSuggestTimer);
  const q = discoverCategoryInput.value.trim();
  if (!q) {
    discoverSuggestionsEl.hidden = true;
    return;
  }
  discoverSuggestTimer = setTimeout(() => fetchCategorySuggestions(q), 250);
});

discoverCategoryInput.addEventListener("blur", () => {
  // Let a suggestion's click register before we hide the list.
  setTimeout(() => (discoverSuggestionsEl.hidden = true), 150);
});

async function fetchCategorySuggestions(q) {
  const seq = ++state.discoverSuggestSeq;
  let categories;
  try {
    ({ categories } = await api(`/api/category-suggest?q=${encodeURIComponent(q)}`));
  } catch {
    return;
  }
  if (seq !== state.discoverSuggestSeq) return; // superseded by newer typing
  if (!categories.length) {
    discoverSuggestionsEl.hidden = true;
    return;
  }
  discoverSuggestionsEl.innerHTML = categories
    .map((c) => `<button type="button" class="discover-suggestion">${escapeHtml(c)}</button>`)
    .join("");
  discoverSuggestionsEl.hidden = false;
}

discoverSuggestionsEl.addEventListener("mousedown", (e) => {
  // mousedown (not click) fires before the input's blur handler hides us.
  const btn = e.target.closest(".discover-suggestion");
  if (!btn) return;
  const name = btn.textContent;
  discoverCategoryInput.value = name;
  discoverSuggestionsEl.hidden = true;
  selectDiscoverCategory({ label: name, value: name });
});

async function fetchDiscover() {
  const seq = ++state.discoverSeq;
  const cat = state.discoverCategory;
  $("#discover-title").textContent = cat.value ? `Category: ${cat.label}` : "Random Articles";
  const tbody = $("#discover-table tbody");
  $("#discover-empty").hidden = true;
  tbody.innerHTML = `<tr><td colspan="6" class="empty">Loading…</td></tr>`;

  let items;
  try {
    const qs = cat.value ? `?category=${encodeURIComponent(cat.value)}` : "";
    ({ items } = await api(`/api/discover${qs}`));
  } catch (err) {
    if (seq !== state.discoverSeq) return; // superseded by a newer request
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  // A newer shuffle/category click landed first - drop this stale response.
  if (seq !== state.discoverSeq) return;

  state.discover = items;
  tbody.innerHTML = "";
  if (!items.length) {
    $("#discover-empty").hidden = false;
    return;
  }
  for (const r of items) tbody.appendChild(buildArticleRow(r));
}

function renderDiscoverPage() {
  renderDiscoverCategoryChips();
  if (!state.discover.length) fetchDiscover();
}

async function renderMarket() {
  // Search results only apply to the primary market - jump back to it if a
  // search lands while the secondary tab is showing.
  if (state.route.q) state.marketTab = "primary";
  setMarketTab(state.marketTab);
  renderSecondaryMarket(); // independent of the primary table's load state below

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

  for (const r of items) tbody.appendChild(buildArticleRow(r));
}

// Shared row builder for any table of priced/ownership-decorated articles
// (primary market, search results, discover) - same columns, same
// Claim/Owned/Buy-listing/retry button logic everywhere.
function buildArticleRow(r) {
  const title = r.title || r.displayTitle;
  // Signed out: don't disable on affordability (we don't know their
  // balance) - clicking prompts sign-in instead.
  const affordable = r.price != null && (!state.user || state.me.user.credits >= r.price);
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
    <td>${badgeHtml(pickChangePct(r), r.pendingLatest)}</td>
    <td>${sparkSvg(r.spark, pickChangePct(r))}</td>
    <td><button class="btn-primary btn-sm"></button></td>`;
  const btn = tr.querySelector("button");
  // Ownership is exclusive - "Claim" only makes sense for genuinely
  // unowned articles. Owned-and-listed routes to buying the listing
  // instead; owned-and-unlisted just isn't available right now.
  if (r.ownedByMe) {
    btn.textContent = "Owned";
    btn.disabled = true;
  } else if (r.owned && r.listing) {
    const listingAffordable = !state.user || state.me.user.credits >= r.listing.askPrice;
    btn.textContent = listingAffordable ? `Buy for ${fmt(r.listing.askPrice)}` : "Too pricey";
    btn.disabled = !listingAffordable;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      buyListingAction(r.listing.id, title, r.listing.askPrice);
    });
  } else if (r.owned) {
    btn.textContent = "Not for sale";
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
  return tr;
}

function renderSecondaryMarket() {
  const tbody = $("#secondary-market-table tbody");
  const items = state.listings;
  $("#secondary-market-empty").hidden = items.length > 0;
  $("#secondary-market-table").hidden = items.length === 0;
  tbody.innerHTML = "";
  for (const l of items) {
    const isMine = state.user && l.sellerId === state.user.id;
    const affordable = !state.user || state.me.user.credits >= l.askPrice;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(l)}
          <div>
            <div class="cell-title">${escapeHtml(l.displayTitle)}</div>
            <div class="cell-sub">${escapeHtml(l.description || "")}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(l.sellerUsername)}</td>
      <td class="num">${fmt(l.askPrice)}</td>
      <td class="num">${l.marketPrice == null ? "—" : fmt(l.marketPrice)}</td>
      <td><button class="btn-sm"></button></td>`;
    const btn = tr.querySelector("button");
    if (isMine) {
      btn.className = "btn-ghost btn-sm";
      btn.textContent = "Cancel Listing";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelListingAction(l.id, l.displayTitle);
      });
    } else {
      btn.className = "btn-primary btn-sm";
      btn.textContent = affordable ? `Buy for ${fmt(l.askPrice)}` : "Too pricey";
      btn.disabled = !affordable;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        buyListingAction(l.id, l.displayTitle, l.askPrice);
      });
    }
    tr.addEventListener("click", () => openArticle(l.article));
    tbody.appendChild(tr);
  }
}

function loadListings() {
  api("/api/listings")
    .then(({ listings }) => {
      state.listings = listings;
      if (state.route.page === "market") renderSecondaryMarket();
    })
    .catch(() => {});
}

/* ================= watchlist page ================= */

function renderWatchlistPage() {
  $("#watchlist-signedout").hidden = !!state.user;
  $("#watchlist-content").hidden = !state.user;
  if (!state.user) return;

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
      <td>${badgeHtml(pickChangePct(w), w.pendingLatest)}</td>
      <td>${sparkSvg(w.spark, pickChangePct(w))}</td>
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
  $("#predictions-signedout").hidden = !!state.user;
  $("#predictions-content").hidden = !state.user;
  if (!state.user) return;

  const open = state.bets.open;
  const resolved = state.bets.resolved;

  const openTbody = $("#bets-open-table tbody");
  $("#bets-open-empty").hidden = open.length > 0;
  $("#bets-open-table").hidden = open.length === 0;
  openTbody.innerHTML = "";
  for (const b of open) {
    const pctChange = (b.currentViews - b.startViews) / b.startViews;
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
      <td class="num">${fmt(b.startViews)} → ${fmt(b.currentViews)}</td>
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
      <td class="num">${fmt(b.startViews)} → ${fmt(b.endViews)}</td>
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
  const detCp = pickChangePct(d);
  if (d.pendingLatest) {
    changeEl.className = "badge pending";
    changeEl.textContent = resultsInText();
  } else if (detCp == null) {
    changeEl.className = "badge";
    changeEl.textContent = "";
  } else {
    const up = detCp >= 0;
    changeEl.className = `badge ${up ? "up" : "down"}`;
    changeEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(detCp)}% ${CHANGE_BASIS[state.changeBasis].suffix}`;
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
    const winning = (b.direction === "up") === (b.currentViews >= b.startViews);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mini-main">
        <div class="mini-title">${b.direction === "up" ? "▲ Up" : "▼ Down"} · staked ${fmt(b.stake)} pts</div>
        <div class="mini-sub">${formatCountdown(b.resolvesAt)} · currently ${winning ? "winning" : "losing"}</div>
      </div>
      <div class="mini-right">
        <div class="mini-price ${winning ? "pos" : "neg"}">${fmt(b.currentViews)}</div>
        <div class="mini-change">from ${fmt(b.startViews)}</div>
      </div>`;
    ul.appendChild(li);
  }
}

function renderDetailActions() {
  const d = state.detail;
  if (!d) return;
  const actionBtn = $("#det-action");
  const listBtn = $("#det-list-btn");
  const watchBtn = $("#det-watch");
  listBtn.hidden = true;

  if (d.holding) {
    // Ownership is exclusive, but instant "Sell" and listing on the
    // secondary market are independent options for an owner either way.
    actionBtn.textContent = d.price == null
      ? `Sell for ${fmt(d.holding.purchasePrice)} pts (last known price)`
      : `Sell for ${fmt(d.price)} pts`;
    actionBtn.disabled = false;
    actionBtn.onclick = () => sell(d.holding.id, d.displayTitle);

    listBtn.hidden = false;
    if (d.listing) {
      listBtn.textContent = `Cancel Listing (asked ${fmt(d.listing.askPrice)})`;
      listBtn.onclick = () => cancelListingAction(d.listing.id, d.displayTitle);
    } else {
      listBtn.textContent = "List for Sale";
      listBtn.onclick = () => listHolding(d.holding.id, d.displayTitle, d.price ?? d.holding.purchasePrice);
    }
  } else if (d.owned && d.listing) {
    const affordable = !state.user || state.me.user.credits >= d.listing.askPrice;
    actionBtn.textContent = affordable
      ? `Buy for ${fmt(d.listing.askPrice)} pts (resale)`
      : `Need ${fmt(d.listing.askPrice)} pts (resale)`;
    actionBtn.disabled = !affordable;
    actionBtn.onclick = () => buyListingAction(d.listing.id, d.displayTitle, d.listing.askPrice);
  } else if (d.owned) {
    actionBtn.textContent = "Owned — not for sale";
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  } else if (d.price == null) {
    // No pricing data right now — can't buy without it.
    actionBtn.textContent = "Re-check price";
    actionBtn.disabled = false;
    actionBtn.onclick = () => reprice(d.article, d.displayTitle, actionBtn);
  } else if (!state.user || state.me.user.credits >= d.price) {
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
  const detCp = pickChangePct(d);
  const rows = [
    ["Market price", d.price == null ? "—" : `${fmt(d.price)} pts`],
    ["Views (last day)", d.latestViews == null ? "—" : fmt(d.latestViews)],
    [CHANGE_BASIS[state.changeBasis].statLabel, d.pendingLatest ? resultsInText() : detCp == null ? "—" : `${detCp >= 0 ? "+" : ""}${detCp}%`],
    ["Status", d.holding
      ? "In your portfolio"
      : d.owned
      ? (d.listing ? `Owned by another player — listed for ${fmt(d.listing.askPrice)} pts` : "Owned by another player")
      : "Unowned"],
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
  if (!ensureSignedIn()) return;
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
  if (!ensureSignedIn()) return;
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

async function listHolding(holdingId, title, currentMarketPrice) {
  if (!ensureSignedIn()) return;
  const input = prompt(
    `List "${title}" for sale on the secondary market.\nCurrent market price: ${fmt(currentMarketPrice)} pts.\nEnter your asking price:`,
    String(currentMarketPrice)
  );
  if (input == null) return; // cancelled
  const askPrice = Number(input);
  if (!Number.isFinite(askPrice) || askPrice < 1) {
    toast("Enter a valid asking price.", true);
    return;
  }
  try {
    const res = await api("/api/listings", {
      method: "POST",
      body: JSON.stringify({ holdingId, askPrice }),
    });
    toast(`Listed "${title}" for ${fmt(res.listing.askPrice)} pts.`);
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

async function cancelListingAction(listingId, title) {
  if (!ensureSignedIn()) return;
  try {
    await api(`/api/listings/${listingId}/cancel`, { method: "POST" });
    toast(`Cancelled the listing for "${title}".`);
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

async function buyListingAction(listingId, title, price) {
  if (!ensureSignedIn()) return;
  try {
    const res = await api(`/api/listings/${listingId}/buy`, { method: "POST" });
    toast(`Bought "${title}" for ${fmt(res.price)} pts.`);
    await refreshAfterTrade();
    if (state.route.page === "article" && state.detail?.article) {
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
  if (!ensureSignedIn()) return;
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
  if (!ensureSignedIn()) return;
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

// Browsing works immediately, with no dependency on Clerk - render the app
// and load public data right away. If a Clerk session exists, initClerk()
// picks it up asynchronously afterward and refreshes personal data/chrome.
if (!location.hash) location.hash = "#/overview";
renderAuthChrome();
renderRoute();
loadSecondary();

initClerk().catch((err) => {
  console.error(err);
  toast("Couldn't load sign-in — you can still browse.", true);
});
