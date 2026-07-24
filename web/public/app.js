const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const initials = (s) => (s || "?").trim().slice(0, 1).toUpperCase();

// Right after each UTC day rolls over, some (not necessarily all) holdings
// haven't been credited for it yet - almost always because Wikimedia hasn't
// published that article's numbers yet (see todayEarningsPending in
// game.js's portfolio()). That's "we don't know yet", not "you earned
// nothing" - showing "Pending" instead of "+0" keeps the lag window from
// reading as a real, final zero.
function todayEarningsText(me) {
  if (me.todayEarningsPending && me.todayEarnings === 0) return "Pending";
  return `+${fmt(me.todayEarnings)}`;
}

const state = {
  user: null,
  me: null,
  // Clerk restores its browser session asynchronously. Keep that distinct
  // from a confirmed signed-out state so refreshes don't flash a false logout.
  authStatus: "loading", // loading | restoring | signedIn | signedOut | error
  authDisplayName: "",
  signInOpening: false,
  categories: [],
  trending: [],
  watchlist: [],
  activity: [],
  leaderboard: [],
  bets: { open: [], resolved: [] },
  notifications: [],
  notifUnread: 0,
  listings: [],
  discover: [],
  // "views" only applies with a real category selected - ranking "most
  // viewed" within the no-category random pool isn't meaningful (that's
  // what the Trending page is for), so picking "Random" as the category
  // resets this back to "random" too (see selectDiscoverCategory).
  discoverSort: "random",
  discoverCategory: null, // set below once DISCOVER_CATEGORIES exists (defaults to "Random")
  discoverSeq: 0,
  discoverSuggestSeq: 0,
  detail: null,
  route: { page: "overview" },
  ovDays: 30,
  detDays: 30,
  moversTab: "trending",
  marketSort: "trending",
  marketTab: "primary",
  chartSeq: 0,
  ptsRange: "day", // "day" | "week" | "month" - see EARNINGS_BUCKETERS
  pointsHistory: null, // raw earn events from /api/points, re-bucketed client-side on range change
  overviewChartHistory: null,
  detailChartHistory: null,
};

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

  // Without a timeout, a slow/stalled backend call (e.g. one that's waiting
  // on Wikimedia) leaves callers like signInSucceeded() awaiting forever -
  // "Checking your session..." never resolves either way. Fail fast so
  // every caller's existing error handling actually gets a chance to run.
  let res;
  try {
    res = await fetch(path, { headers, ...opts, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("Request timed out - the server is taking too long to respond.");
    }
    throw e;
  }
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

// Wikimedia's publish lag isn't a fixed, predictable duration (it can be
// anywhere from a couple hours to most of a day - see the lag-consistency
// monitor) - a specific countdown here would just be fabricated precision
// about something we genuinely don't know yet.
const RESULTS_PENDING_TEXT = "Results pending";

function badgeHtml(changePct, pendingLatest) {
  if (pendingLatest) return `<span class="badge pending">${RESULTS_PENDING_TEXT}</span>`;
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

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatShortDate(yyyymmdd) {
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  return `${SHORT_MONTHS[m]} ${d}`;
}

// Same short "Mon D" format as formatShortDate, but for a ms timestamp
// (placedAt/resolvedAt) rather than a YYYYMMDD date string.
function formatShortDateFromTs(ts) {
  const d = new Date(ts);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
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

/**
 * Smooth line + gradient area chart. gradId must be unique per chart slot.
 * width/height should match the container's actual rendered size - the SVG
 * uses preserveAspectRatio="none" to fill it exactly, so a mismatched
 * viewBox (a fixed guess, rather than the real box) stretches the curve on
 * wide screens. See chartDims, which measures the real container.
 */
function bigChartSvg(history, gradId, width = 720, height = 250) {
  if (!history || !history.length) return "";
  const W = width, H = height, padL = 46, padR = 12, padT = 12, padB = 24;
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

// The real rendered size of a chart container, for bigChartSvg's width/
// height params. Falls back to the old fixed guess only if the container
// somehow reports zero size (e.g. measured before layout settles).
function chartDims(holderId) {
  const rect = $(`#${holderId}`).getBoundingClientRect();
  return { width: rect.width || 720, height: rect.height || 250 };
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
  const signedIn = state.authStatus === "signedIn" && !!state.user;
  const restoring = state.authStatus === "restoring";
  const checking = state.authStatus === "loading" || restoring;
  const hasSession = signedIn || restoring;
  $("#hdr-networth-stat").hidden = !signedIn;
  $("#hdr-today-stat").hidden = !signedIn;
  $("#hdr-profile").hidden = !hasSession;
  $("#hdr-signin-btn").hidden = hasSession;
  $("#notif-bell").hidden = !signedIn;
  if (!signedIn) {
    closeNotifPanel();
    state.notifications = [];
    state.notifUnread = 0;
    renderNotifBadge();
  }
  $("#sidebar-profile").hidden = !hasSession;
  $("#sidebar-points-card").hidden = !signedIn;
  $("#logout-btn").hidden = !signedIn;
  $("#sidebar-signedout-card").hidden = hasSession;
  $("#sidebar-signin-btn").hidden = hasSession;

  if (restoring) {
    const name = state.authDisplayName || "Signed in";
    $("#hdr-username").textContent = `${name} · Loading…`;
    $("#side-username").textContent = `${name} · Loading…`;
    $("#hdr-avatar").textContent = initials(name);
    $("#side-avatar").textContent = initials(name);
  }

  const buttonLabels = {
    "hdr-signin-btn": "Sign In",
    "sidebar-signin-btn": "Sign In",
    "ov-signin-btn": "Sign In to Start Trading",
    "points-signin-btn": "Sign In",
    "watchlist-signin-btn": "Sign In",
    "predictions-signin-btn": "Sign In",
    "lootbox-signin-btn": "Sign In",
  };
  for (const [id, readyLabel] of Object.entries(buttonLabels)) {
    const button = $(`#${id}`);
    button.disabled = checking || state.signInOpening;
    button.textContent = checking
      ? "Checking session…"
      : state.signInOpening
        ? "Opening sign in…"
        : readyLabel;
  }

  const signedOutCard = $("#sidebar-signedout-card");
  if (!signedOutCard.hidden) {
    signedOutCard.querySelector(".side-card-label").textContent = checking
      ? "Checking session"
      : "Not signed in";
    signedOutCard.querySelector(".side-card-hint").textContent = checking
      ? "Restoring your account…"
      : "Sign in to buy, sell, and predict";
  }
}

function authIsPending() {
  return state.authStatus === "loading" || state.authStatus === "restoring";
}

function authIsSignedOut() {
  return state.authStatus === "signedOut" || state.authStatus === "error";
}

// Gate for any action that needs an account (buy, sell, list, predict,
// watch...). Opens Clerk's sign-in modal on demand instead of a full-page
// gate - browsing works with no account at all. Returns whether the caller
// can proceed right now.
function ensureSignedIn() {
  if (state.user) return true;
  if (authIsPending()) {
    toast("Restoring your session…");
    return false;
  }
  if (!window.Clerk) {
    toast("Sign-in is still loading. Try again in a moment.", true);
    return false;
  }

  // Paint feedback before Clerk prepares its modal. On a cold load that can
  // take a moment, but the click should never appear to have done nothing.
  state.signInOpening = true;
  renderAuthChrome();
  setTimeout(() => {
    try {
      window.Clerk.openSignIn({});
    } finally {
      setTimeout(() => {
        state.signInOpening = false;
        renderAuthChrome();
      }, 1500);
    }
  }, 0);
  return false;
}

// Clicking your name/avatar opens Clerk's own account-management modal -
// profile picture upload, email, password, connected accounts, etc. are
// all handled there natively, nothing custom to build.
function openAccountManagement() {
  window.Clerk?.openUserProfile({});
}
for (const id of ["hdr-profile", "sidebar-profile"]) {
  const el = $(`#${id}`);
  el.addEventListener("click", openAccountManagement);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openAccountManagement();
    }
  });
}

// Nothing ever retried a failed restore, so one transient slow spell (a cold
// server, or Wikimedia's publish lag making /api/me slow) left the app on
// "Checking your session…" with a manual page refresh as the only way out.
// Keep trying quietly in the background so it heals itself instead.
let restoreRetryTimer = null;
let restoreRetries = 0;
const RESTORE_RETRY_DELAYS_MS = [10000, 30000, 60000];
function scheduleRestoreRetry() {
  const delay = RESTORE_RETRY_DELAYS_MS[restoreRetries];
  if (delay == null) return false; // out of attempts; the "try refreshing" toast stands
  restoreRetries++;
  clearTimeout(restoreRetryTimer);
  restoreRetryTimer = setTimeout(() => {
    // Only if it's still broken and there's still a session to restore.
    if (state.authStatus === "error" && window.Clerk?.user) signInSucceeded(window.Clerk.user);
  }, delay);
  return true;
}

let signingIn = false;
async function signInSucceeded(clerkUser) {
  if (signingIn) return; // the Clerk listener can fire repeatedly; don't stack
  signingIn = true;
  state.signInOpening = false;
  state.authStatus = "restoring";
  state.authDisplayName =
    clerkUser?.username || clerkUser?.firstName || clerkUser?.primaryEmailAddress?.emailAddress || "Signed in";
  renderAuthChrome();
  renderRoute();
  try {
    const ok = await loadMeWithRetry();
    if (!ok) {
      state.authStatus = "error";
      renderAuthChrome();
      renderRoute();
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
    state.authStatus = "signedIn";
    clearTimeout(restoreRetryTimer);
    restoreRetries = 0;
    renderAuthChrome();
    loadSecondary();
    renderRoute();
    if (state.user.needsUsername) openUsernameModal();
  } catch (err) {
    state.authStatus = "error";
    renderAuthChrome();
    renderRoute();
    console.error("Failed to restore signed-in account:", err);
    const retrying = scheduleRestoreRetry();
    toast(
      retrying
        ? "Your account data is taking a while to load — retrying…"
        : "Signed in, but your account data couldn't be loaded. Try refreshing.",
      true
    );
  } finally {
    signingIn = false;
  }
}

async function initClerk() {
  const Clerk = await waitForClerkScript();
  await Clerk.load();
  // Restore the already-loaded user directly, then listen for real changes.
  // This avoids waiting for the listener's first asynchronous notification.
  let lastUserId = "__init__";
  const syncUser = async (user) => {
    const id = user?.id ?? null;
    if (id === lastUserId) return;
    lastUserId = id;
    if (user) {
      await signInSucceeded(user);
    } else {
      state.user = null;
      state.me = null;
      state.authStatus = "signedOut";
      state.authDisplayName = "";
      state.signInOpening = false;
      renderAuthChrome();
      renderRoute(); // re-render the current page in its signed-out form
    }
  };
  await syncUser(Clerk.user);
  Clerk.addListener(({ user }) => {
    syncUser(user).catch((err) => console.error("Clerk session update failed:", err));
  });
}

$("#logout-btn").addEventListener("click", () => window.Clerk?.signOut());
$("#hdr-signin-btn").addEventListener("click", ensureSignedIn);
$("#sidebar-signin-btn").addEventListener("click", ensureSignedIn);
$("#ov-signin-btn").addEventListener("click", ensureSignedIn);
$("#points-signin-btn").addEventListener("click", ensureSignedIn);
$("#watchlist-signin-btn").addEventListener("click", ensureSignedIn);
$("#predictions-signin-btn").addEventListener("click", ensureSignedIn);
$("#lootbox-signin-btn").addEventListener("click", ensureSignedIn);

/* ================= username modal ================= */
// Every newly-provisioned account starts with an auto-generated placeholder
// name and needsUsername=true - this modal is mandatory (no close button)
// until they set a real one, right after their first sign-in.

function openUsernameModal() {
  $("#username-error").hidden = true;
  $("#username-input").value = "";
  $("#username-modal").hidden = false;
  $("#username-input").focus();
}

function closeUsernameModal() {
  $("#username-modal").hidden = true;
}

$("#username-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#username-input").value.trim();
  const errorEl = $("#username-error");
  const submitBtn = $("#username-submit");
  errorEl.hidden = true;

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    errorEl.textContent = "3-20 characters: letters, numbers, and underscores only.";
    errorEl.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  try {
    const { user } = await api("/api/username", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    state.user = user;
    if (state.me) state.me.user = user;
    closeUsernameModal();
    renderChrome();
    renderRoute();
    toast(`Username set to ${user.username}.`);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

/* ================= getting-started tour ================= */
// A short, dismissible walkthrough of the core mechanics, shown only to
// first-time visitors - browsing doesn't require an account, so this
// (unlike the username modal) needs to work for signed-out visitors too.
// Auto-shown once per browser (localStorage, since it's a UI preference,
// not account data - a signed-in user on a second device would just see it
// once more there, which is fine) and never re-shown after that; there's no
// manual re-open, by design.

const TOUR_SEEN_KEY = "wikipicks_tour_seen";

const TOUR_STEPS = [
  {
    icon: "📖",
    title: "Welcome to WikiPicks",
    body: "Every Wikipedia article is a tradeable asset, priced from its real traffic. Buy undervalued ones, earn from their readership, and climb the leaderboard. Browsing is free — sign in only to buy, sell, predict, or watch.",
  },
  {
    icon: "💰",
    title: "Claim an article",
    body: "Price = a year of average daily views, plus a bonus for a strong recent month. Ownership is exclusive — once claimed, it's off the market. Find articles on Market, Discover, or search.",
  },
  {
    icon: "📈",
    title: "Earn every day",
    body: "Owned articles pay you their real daily view count in points, starting the day after purchase. Views publish about a day late, so today's earnings show up tomorrow — settled automatically whenever you open the app.",
  },
  {
    icon: "🔮",
    title: "Predict without owning",
    body: "Stake points on an article's exact view count tomorrow — no purchase needed. Land close and get back more than your stake; miss wide and get back less. Resolves as soon as the real numbers publish.",
  },
  {
    icon: "🏆",
    title: "Track your progress",
    body: "The Points page tracks your balance and progress toward 1,000,000 points ($25 gift card). The Leaderboard ranks net worth — points plus everything you own. Start with 5,000 points.",
  },
];

let tourStepIndex = 0;

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIndex];
  $("#tour-icon").textContent = step.icon;
  $("#tour-title").textContent = step.title;
  $("#tour-body").textContent = step.body;
  $("#tour-dots").innerHTML = TOUR_STEPS.map(
    (_, i) => `<span class="${i === tourStepIndex ? "active" : ""}"></span>`
  ).join("");
  $("#tour-back-btn").classList.toggle("tour-back-hidden", tourStepIndex === 0);
  $("#tour-next-btn").textContent = tourStepIndex === TOUR_STEPS.length - 1 ? "Get Started" : "Next";
}

function openTour() {
  tourStepIndex = 0;
  renderTourStep();
  $("#tour-modal").hidden = false;
}

function closeTour() {
  $("#tour-modal").hidden = true;
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* private browsing / storage disabled - just means it may auto-show again next visit */
  }
}

$("#tour-close-btn").addEventListener("click", closeTour);
$("#tour-modal").addEventListener("click", (e) => {
  if (e.target.id === "tour-modal") closeTour(); // click on the backdrop
});
$("#tour-back-btn").addEventListener("click", () => {
  if (tourStepIndex > 0) {
    tourStepIndex--;
    renderTourStep();
  }
});
$("#tour-next-btn").addEventListener("click", () => {
  if (tourStepIndex < TOUR_STEPS.length - 1) {
    tourStepIndex++;
    renderTourStep();
  } else {
    closeTour();
  }
});

/* ================= data loading ================= */

// The server bounds how long /api/me waits for settlement to finish (see
// SETTLE_DEADLINE_MS in game.js) so a slow Wikimedia round trip can't hang
// the request - when that deadline is hit, me.settling is true and the
// numbers just returned may already be stale (the settle pass is still
// running server-side and will land moments later). Without this, seeing the
// credited amount meant manually refreshing the page; instead, quietly ask
// again shortly after. Capped so a persistently-stuck pass doesn't poll
// forever.
let settleRefreshTimer = null;
let settleRefreshAttempts = 0;
const SETTLE_REFRESH_DELAY_MS = 3000;
const SETTLE_REFRESH_MAX_ATTEMPTS = 5;

async function loadMe() {
  const me = await api("/api/me");
  if (!me.user) return false;
  state.user = me.user;
  state.me = me;
  renderChrome();
  clearTimeout(settleRefreshTimer);
  if (me.settling && settleRefreshAttempts < SETTLE_REFRESH_MAX_ATTEMPTS) {
    settleRefreshAttempts++;
    settleRefreshTimer = setTimeout(() => {
      if (state.user) loadMe().catch(() => {});
    }, SETTLE_REFRESH_DELAY_MS);
  } else {
    settleRefreshAttempts = 0;
  }
  return true;
}

// A cold server (Railway spinning up after being idle, or the first
// post-deploy request needing to live-price every article in someone's
// portfolio before anything's cached) can genuinely take longer than a
// single request should wait - api()'s 15s timeout can cut that off even
// though the server would have come back fine a few seconds later. Without
// this, the only way to recover was to notice the error and manually
// refresh; a couple of automatic retries means a transient cold-start
// self-heals instead of surfacing as a hard failure.
async function loadMeWithRetry(maxAttempts = 3, delaysMs = [1000, 2000]) {
  let lastErr = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (await loadMe()) return true;
    } catch (err) {
      lastErr = err;
    }
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delaysMs[i] ?? 2000));
  }
  if (lastErr) throw lastErr;
  return false; // exhausted retries with no thrown error - a real no-token/misconfig case
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
      // Checking bets can lazily resolve one server-side (a payout lands the
      // moment its target day's data is available, see game.js) - refresh
      // the displayed balance so it doesn't sit stale until some other
      // action happens to re-fetch /api/me.
      loadMe();
    }).catch(() => {});
    loadNotifications();
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

/* ================= notification center ================= */

function renderNotifBadge() {
  const badge = $("#notif-badge");
  const n = state.notifUnread || 0;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
}

// Each type renders from its own structured fields (amount/article/
// displayTitle) rather than a server-composed string, matching how
// feedItemHtml renders the public activity feed - keeps number/date
// formatting consistent with the rest of the UI (fmt(), relTime()).
function notifText(n) {
  const title = escapeHtml(n.displayTitle || "");
  if (n.type === "daily-earnings") {
    return { icon: "💰", text: `You earned <b>${fmt(n.amount)} pts</b> today.` };
  }
  if (n.type === "escrow-released") {
    return { icon: "✅", text: `Your held earnings for <b>${title}</b> (${fmt(n.amount)} pts) were released to your balance.` };
  }
  if (n.type === "escrow-forfeited") {
    return { icon: "⚠️", text: `Your held earnings for <b>${title}</b> (${fmt(n.amount)} pts) were forfeited after review.` };
  }
  return { icon: "🔔", text: "You have a new notification." };
}

function notifItemHtml(n) {
  const { icon, text } = notifText(n);
  return `
    <li class="notif-item${n.read ? "" : " unread"}" data-id="${escapeHtml(n.id)}">
      <span class="notif-icon">${icon}</span>
      <div class="notif-body">
        <div class="notif-text">${text}</div>
        <div class="notif-time">${relTime(n.createdAt)}</div>
      </div>
    </li>`;
}

function renderNotifList() {
  const list = $("#notif-list");
  const items = state.notifications || [];
  $("#notif-empty").hidden = items.length > 0;
  list.hidden = items.length === 0;
  list.innerHTML = items.map(notifItemHtml).join("");
}

async function loadNotifications() {
  if (!state.user) return;
  try {
    const { notifications, unread } = await api("/api/notifications");
    state.notifications = notifications;
    state.notifUnread = unread;
    renderNotifBadge();
    if (!$("#notif-panel").hidden) renderNotifList();
  } catch {
    /* header chrome shouldn't break if this fails */
  }
}

function closeNotifPanel() {
  $("#notif-panel").hidden = true;
  $("#notif-bell-btn").setAttribute("aria-expanded", "false");
}

$("#notif-bell-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const panel = $("#notif-panel");
  const opening = panel.hidden;
  if (!opening) {
    closeNotifPanel();
    return;
  }
  panel.hidden = false;
  $("#notif-bell-btn").setAttribute("aria-expanded", "true");
  renderNotifList();
  await loadNotifications();
});

document.addEventListener("click", (e) => {
  const bell = $("#notif-bell");
  if (bell.hidden || bell.contains(e.target)) return;
  closeNotifPanel();
});

$("#notif-list").addEventListener("click", async (e) => {
  const li = e.target.closest(".notif-item.unread");
  if (!li) return;
  const id = li.dataset.id;
  li.classList.remove("unread");
  const n = state.notifications.find((x) => x.id === id);
  if (n) n.read = true;
  state.notifUnread = Math.max(0, (state.notifUnread || 0) - 1);
  renderNotifBadge();
  try {
    await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  } catch {
    /* best effort - not worth surfacing a failed read-receipt to the user */
  }
});

$("#notif-read-all").addEventListener("click", async () => {
  state.notifications = (state.notifications || []).map((n) => ({ ...n, read: true }));
  state.notifUnread = 0;
  renderNotifBadge();
  renderNotifList();
  try {
    await api("/api/notifications/read-all", { method: "POST" });
  } catch {
    /* best effort */
  }
});

/* ================= chrome (sidebar / header) ================= */

function renderChrome() {
  const me = state.me;
  if (!me) return;
  $("#side-credits").textContent = fmt(me.user.credits);
  $("#hdr-networth").textContent = fmt(me.netWorth);
  $("#hdr-today").textContent = todayEarningsText(me);
  $("#hdr-username").textContent = me.user.username;
  $("#hdr-avatar").textContent = initials(me.user.username);
  $("#side-username").textContent = me.user.username;
  $("#side-avatar").textContent = initials(me.user.username);
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

const PAGES = ["overview", "points", "market", "lootbox", "discover", "watchlist", "predictions", "leaderboard", "activity", "about", "article"];

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
  else if (page === "lootbox") renderLootboxPage();
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

/* ================= overview ================= */

function renderOverview() {
  const me = state.me;
  $("#ov-signedout").hidden = !authIsSignedOut();
  $("#ov-content").hidden = !me;

  // These sections are public data - render regardless of sign-in.
  renderMovers();
  renderOvActivity();
  renderOvWatchlist();

  if (!me) return;

  $("#ov-chart-value").textContent =
    me.todayEarningsPending && me.todayEarnings === 0 ? "Pending" : fmt(me.todayEarnings);

  const rank = me.rank ? `#${me.rank} of ${me.totalPlayers}` : "—";
  $("#metric-stack").innerHTML = [
    ["Portfolio Value", fmt(me.netWorth)],
    ["Wiki Points", fmt(me.user.credits)],
    ["Total Earned", `+${fmt(me.totalEarned)}`],
    ["Today's Earnings", todayEarningsText(me)],
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
            ${h.escrowedEarned > 0 ? `<div class="cell-sub escrow-note" title="A view spike on this article exceeded the normal daily range, so the extra earnings are held pending a manual review rather than paid out automatically.">⏳ ${fmt(h.escrowedEarned)} pts held for review</div>` : ""}
          </div>
        </div>
      </td>
      <td class="num">${fmt(h.purchasePrice)}</td>
      <td class="num">${fmt(h.currentPrice)}</td>
      <td class="num">${h.latestViews == null ? "—" : fmt(h.latestViews)}</td>
      <td class="num pos">+${fmt(h.totalEarned)}</td>
      <td>${badgeHtml(h.changePct, h.pendingLatest)}</td>
      <td>${sparkSvg(h.spark, h.changePct)}</td>
      <td class="holding-actions"></td>`;
    const actionsTd = tr.querySelector(".holding-actions");
    if (h.listing) {
      actionsTd.innerHTML = `<span class="listed-tag">Listed ${fmt(h.listing.askPrice)}</span><button class="btn-ghost btn-sm">Cancel</button>`;
      actionsTd.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        cancelListingAction(h.id, h.displayTitle);
      });
    } else {
      actionsTd.innerHTML = `<button class="btn-ghost btn-sm">List</button>`;
      actionsTd.querySelector("button").addEventListener("click", (e) => {
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
    state.overviewChartHistory = history; // for a resize redraw with no refetch
    const dims = chartDims("ov-chart");
    holder.innerHTML = history.length
      ? bigChartSvg(history, "gradOverview", dims.width, dims.height)
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
  const changeHtml = item.pendingLatest
    ? `<div class="mini-change">${RESULTS_PENDING_TEXT}</div>`
    : `<div class="mini-change ${up ? "pos" : "neg"}">${up ? "+" : ""}${item.changePct ?? 0}%</div>`;
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
    ul.innerHTML = `<li class="empty">${authIsPending() ? "Checking your session…" : "Sign in to build a watchlist."}</li>`;
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
  if (state.moversTab === "gainers") items.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
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
  } else if (ev.type === "lootbox") {
    text = `${user} opened a loot box and got <b>${title}</b>`;
  } else if (ev.type === "earn") {
    text = `${user} earned ${fmt(ev.amount)} pts from <b>${title}</b>`;
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

// Same idea as bucketEarningsByDay, but grouped into Monday-start weeks -
// keyed by that week's Monday so it sorts/labels the same way (formatShortDate
// just reads YYYYMMDD).
function bucketEarningsByWeek(history) {
  const totals = new Map();
  for (const ev of history) {
    const d = new Date(ev.ts);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const mondayOffset = (day.getUTCDay() + 6) % 7; // getUTCDay(): 0=Sun..6=Sat -> 0=Mon..6=Sun
    const monday = new Date(day.getTime() - mondayOffset * 86400000);
    const key = `${monday.getUTCFullYear()}${String(monday.getUTCMonth() + 1).padStart(2, "0")}${String(monday.getUTCDate()).padStart(2, "0")}`;
    totals.set(key, (totals.get(key) || 0) + (ev.amount || 0));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, views]) => ({ date, views }));
}

// Grouped by calendar month, keyed to the 1st (so it's still a valid
// YYYYMMDD for formatShortDate's axis labels - shown as e.g. "Jul 1").
function bucketEarningsByMonth(history) {
  const totals = new Map();
  for (const ev of history) {
    const d = new Date(ev.ts);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`;
    totals.set(key, (totals.get(key) || 0) + (ev.amount || 0));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, views]) => ({ date, views }));
}

const EARNINGS_BUCKETERS = {
  day: bucketEarningsByDay,
  week: bucketEarningsByWeek,
  month: bucketEarningsByMonth,
};

function updateProgressBar(credits, goal) {
  const pct = Math.min(100, (credits / goal) * 100);
  const fill = $("#pts-progress-fill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("goal-reached", credits >= goal);
  $("#pts-progress-current").textContent = `${fmt(credits)} pts`;
  $("#pts-progress-footer").textContent =
    credits >= goal
      ? "🎉 You've passed 1,000,000 points — you've earned a $25 gift card!"
      : `${pct < 1 ? pct.toFixed(2) : Math.round(pct)}% of the way to 1,000,000 pts`;
}

// Re-buckets the already-fetched raw earning events per state.ptsRange and
// redraws the chart - no network call, so the Daily/Weekly/Monthly toggle
// (and a window resize) can call this directly.
function renderPointsChart() {
  const holder = $("#pts-chart");
  const history = state.pointsHistory;
  if (!history) return; // nothing fetched yet
  const series = EARNINGS_BUCKETERS[state.ptsRange](history);
  const total = series.reduce((s, d) => s + d.views, 0);
  $("#pts-chart-value").textContent = `+${fmt(total)}`;
  if (!series.length) {
    holder.innerHTML = `<div class="chart-empty">No earnings yet — buy an article to start earning.</div>`;
    return;
  }
  const dims = chartDims("pts-chart");
  holder.innerHTML = bigChartSvg(series, "gradPoints", dims.width, dims.height);
}

$("#pts-range-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".pill-tab");
  if (!tab) return;
  state.ptsRange = tab.dataset.range;
  $("#pts-range-tabs").querySelectorAll(".pill-tab").forEach((t) =>
    t.classList.toggle("active", t === tab)
  );
  renderPointsChart();
});

async function renderPointsPage() {
  $("#points-signedout").hidden = !authIsSignedOut();
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
  // /api/points can lazily settle holdings/bets server-side (see
  // pointsSummary in game.js) - keep the sidebar/header balance in sync
  // instead of leaving it at whatever /api/me last returned.
  if (state.me && state.me.user.credits !== data.credits) {
    state.me.user.credits = data.credits;
    state.user.credits = data.credits;
    renderChrome();
  }

  state.pointsHistory = data.history; // raw earn events, for the range toggle + a resize redraw with no refetch
  renderPointsChart();

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

// The Random/Most Viewed toggle only makes sense once a real category is
// picked (curated chip or custom search) - hidden otherwise.
function renderDiscoverSortTabs() {
  const el = $("#discover-sort-tabs");
  el.hidden = !state.discoverCategory.value;
  el.querySelectorAll(".pill-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.sort === state.discoverSort)
  );
}

function selectDiscoverCategory(cat) {
  state.discoverCategory = cat;
  if (!cat.value) state.discoverSort = "random"; // see discoverSort's comment in state
  renderDiscoverCategoryChips();
  renderDiscoverSortTabs();
  fetchDiscover();
}

$("#discover-categories").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill-tab");
  if (!btn) return;
  const cat = DISCOVER_CATEGORIES.find((c) => (c.value || "") === btn.dataset.value);
  $("#discover-category-input").value = ""; // a curated chip overrides any typed custom search
  selectDiscoverCategory(cat);
});

$("#discover-sort-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill-tab");
  if (!btn || !state.discoverCategory.value) return;
  state.discoverSort = btn.dataset.sort;
  renderDiscoverSortTabs();
  fetchDiscover();
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
  const sortByViews = !!cat.value && state.discoverSort === "views";
  $("#discover-title").textContent = cat.value
    ? `${sortByViews ? "Most Viewed" : "Category"}: ${cat.label}`
    : "Random Articles";
  const tbody = $("#discover-table tbody");
  $("#discover-empty").hidden = true;
  tbody.innerHTML = `<tr><td colspan="6" class="empty">Loading…</td></tr>`;

  let items;
  try {
    const params = new URLSearchParams();
    if (cat.value) params.set("category", cat.value);
    if (sortByViews) params.set("sort", "views");
    const qs = params.toString() ? `?${params.toString()}` : "";
    ({ items } = await api(`/api/discover${qs}`));
  } catch (err) {
    if (seq !== state.discoverSeq) return; // superseded by a newer request
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  // A newer shuffle/category click landed first - drop this stale response.
  if (seq !== state.discoverSeq) return;

  state.discover = items;
  renderDiscoverTable();
}

// Rebuilds the table from state.discover (no network call) - split out from
// fetchDiscover so renderDiscoverPage can refresh already-loaded rows (e.g.
// after a successful claim) without re-fetching from Wikimedia every time.
function renderDiscoverTable() {
  const tbody = $("#discover-table tbody");
  tbody.innerHTML = "";
  if (!state.discover.length) {
    $("#discover-empty").hidden = false;
    return;
  }
  $("#discover-empty").hidden = true;
  for (const r of state.discover) tbody.appendChild(buildArticleRow(r));
}

function renderDiscoverPage() {
  renderDiscoverCategoryChips();
  renderDiscoverSortTabs();
  if (state.discover.length) renderDiscoverTable();
  else fetchDiscover();
}

// The sort toggle only means something for the unfiltered trending list -
// search results have their own relevance order.
function renderMarketSortTabs() {
  const q = state.route.q || "";
  $("#market-sort-tabs").hidden = !!q;
  $("#market-sort-tabs").querySelectorAll(".pill-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.sort === state.marketSort)
  );
}

$("#market-sort-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".pill-tab");
  if (!tab) return;
  state.marketSort = tab.dataset.sort;
  renderMarket();
});

async function renderMarket() {
  // Search results only apply to the primary market - jump back to it if a
  // search lands while the secondary tab is showing.
  if (state.route.q) state.marketTab = "primary";
  setMarketTab(state.marketTab);
  renderSecondaryMarket(); // independent of the primary table's load state below

  const q = state.route.q || "";
  $("#search-input").value = q;
  renderMarketSortTabs();
  const gainers = !q && state.marketSort === "gainers";
  $("#market-list-title").textContent = q
    ? `Results for "${q}"`
    : gainers
      ? "Top Gainers"
      : "Trending Articles";
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
    // The full candidate pool, ranked by gain rather than price - unlike the
    // Overview page's Market Movers widget (which only has room for 5), every
    // trending article is shown here.
    if (gainers) items = [...items].sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
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
// Shared "who owns this" line for any row with attachOwnership's fields
// (owned/ownedByMe/ownerUsername) - ownership is exclusive, so this is the
// one honest answer to "can I claim this" wherever an article is listed.
function ownerNoteHtml(r) {
  if (!r.owned) return "";
  const who = r.ownedByMe ? "you" : escapeHtml(r.ownerUsername || "another player");
  return `<div class="cell-sub owner-note">Owned by ${who}</div>`;
}

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
          ${ownerNoteHtml(r)}
        </div>
      </div>
    </td>
    <td class="num">${r.price == null ? "—" : fmt(r.price)}</td>
    <td class="num">${r.latestViews == null ? "—" : fmt(r.latestViews)}</td>
    <td>${badgeHtml(r.changePct, r.pendingLatest)}</td>
    <td>${sparkSvg(r.spark, r.changePct)}</td>
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
    btn.textContent = "Claim";
    btn.disabled = !affordable;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      buy({ article: r.article, title, price: r.price }, btn);
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
  $("#watchlist-signedout").hidden = !authIsSignedOut();
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
            ${ownerNoteHtml(w)}
          </div>
        </div>
      </td>
      <td class="num">${w.price == null ? "—" : fmt(w.price)}</td>
      <td>${badgeHtml(w.changePct, w.pendingLatest)}</td>
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

/* ================= prediction payout estimate ================= */
// Mirrors betPayoutMultiple/BET_MAX_GRADED_MULTIPLE in game.js, for showing
// a live "if this resolved right now" estimate on still-open bets. The real
// resolution is always computed server-side - this is display-only.
const BET_BAND_INNER = 0.5;
const BET_BAND_OUTER = 2;
const BET_MAX_PAYOUT_MULTIPLE = 3;
const BET_MAX_GRADED_MULTIPLE = 11;

function estimatePayout(b, currentViews) {
  const baseline = b.baselineAvg || b.startViews || 1;
  const band = b.band || 0.75;
  const cap = Math.max(1, Math.round(baseline * BET_MAX_GRADED_MULTIPLE));
  const graded = Math.min(currentViews, cap);
  const relError = Math.abs(b.guess - graded) / Math.max(1, graded);
  let multiple;
  if (relError <= BET_BAND_INNER * band) multiple = BET_MAX_PAYOUT_MULTIPLE;
  else if (relError >= BET_BAND_OUTER * band) multiple = 0;
  else {
    const span = (BET_BAND_OUTER - BET_BAND_INNER) * band;
    multiple = BET_MAX_PAYOUT_MULTIPLE * (1 - (relError - BET_BAND_INNER * band) / span);
  }
  return Math.round(b.stake * multiple);
}

/* ================= predictions page ================= */

function renderPredictionsPage() {
  $("#predictions-signedout").hidden = !authIsSignedOut();
  $("#predictions-content").hidden = !state.user;
  if (!state.user) return;

  const open = state.bets.open;
  const resolved = state.bets.resolved;

  const openTbody = $("#bets-open-table tbody");
  $("#bets-open-empty").hidden = open.length > 0;
  $("#bets-open-table").hidden = open.length === 0;
  openTbody.innerHTML = "";
  for (const b of open) {
    const estPayout = estimatePayout(b, b.currentViews);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="cell-article">
          ${thumbHtml(b)}
          <div class="cell-title">${escapeHtml(b.displayTitle)}</div>
        </div>
      </td>
      <td class="cell-sub">${formatShortDateFromTs(b.placedAt)}</td>
      <td class="num">${fmt(b.guess)}</td>
      <td class="num">${fmt(b.stake)}</td>
      <td class="num">${fmt(b.currentViews)}</td>
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
      <td class="cell-sub">${formatShortDateFromTs(b.resolvedAt)}</td>
      <td class="num">${fmt(b.guess)}</td>
      <td class="num">${fmt(b.stake)}</td>
      <td class="num">${b.endViews == null ? "—" : fmt(b.endViews)}</td>
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
  if (d.pendingLatest) {
    changeEl.className = "badge pending";
    changeEl.textContent = RESULTS_PENDING_TEXT;
  } else if (d.changePct == null) {
    changeEl.className = "badge";
    changeEl.textContent = "";
  } else {
    const up = d.changePct >= 0;
    changeEl.className = `badge ${up ? "up" : "down"}`;
    changeEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(d.changePct)}% vs yesterday`;
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
    const estPayout = estimatePayout(b, b.currentViews);
    const winning = estPayout >= b.stake;
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mini-main">
        <div class="mini-title">Guessed ${fmt(b.guess)} · staked ${fmt(b.stake)} pts</div>
        <div class="mini-sub">${formatCountdown(b.resolvesAt)} · currently ${winning ? "winning" : "losing"}</div>
      </div>
      <div class="mini-right">
        <div class="mini-price ${winning ? "pos" : "neg"}">${fmt(b.currentViews)}</div>
        <div class="mini-change">est. payout ${fmt(estPayout)}</div>
      </div>`;
    ul.appendChild(li);
  }
}

function renderDetailActions() {
  const d = state.detail;
  if (!d) return;
  const actionBtn = $("#det-action");
  const watchBtn = $("#det-watch");

  if (d.holding) {
    // No instant sell-back to the market - the only way to give up an
    // article is to list it and wait for another player to buy it.
    if (d.listing) {
      actionBtn.textContent = `Cancel Listing (asked ${fmt(d.listing.askPrice)})`;
      actionBtn.disabled = false;
      actionBtn.onclick = () => cancelListingAction(d.listing.id, d.displayTitle);
    } else {
      actionBtn.textContent = "List";
      actionBtn.disabled = false;
      actionBtn.onclick = () => listHolding(d.holding.id, d.displayTitle, d.price ?? d.holding.purchasePrice);
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
    actionBtn.onclick = () => buy({ article: d.article, title: d.displayTitle, price: d.price }, actionBtn);
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
    ["Vs yesterday", d.pendingLatest ? RESULTS_PENDING_TEXT : d.changePct == null ? "—" : `${d.changePct >= 0 ? "+" : ""}${d.changePct}%`],
    ["Status", d.holding
      ? "In your portfolio"
      : d.owned
      ? (d.listing
          ? `Owned by ${d.ownerUsername || "another player"} — listed for ${fmt(d.listing.askPrice)} pts`
          : `Owned by ${d.ownerUsername || "another player"}`)
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
    state.detailChartHistory = history; // for a resize redraw with no refetch
    const dims = chartDims("det-chart");
    holder.innerHTML = history.length
      ? bigChartSvg(history, "gradDetail", dims.width, dims.height)
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

// Any cached list (trending, discover, watchlist) can still hold a
// just-bought article with stale ownership fields - patch it in place so a
// re-render from cache (no re-fetch) shows "Owned" instead of a fresh,
// wrongly-enabled "Claim" button.
function markOwnedInCachedLists(article) {
  for (const list of [state.trending, state.discover, state.watchlist]) {
    const item = list.find((x) => x.article === article);
    if (item) {
      item.owned = true;
      item.ownedByMe = true;
      item.listing = null;
    }
  }
}

// Claiming is irreversible-ish (real points, exclusive ownership) - confirm
// with an in-app modal instead of buying the instant a button is clicked.
let pendingClaim = null; // { r, btn } while the modal is open

function buy(r, btn) {
  if (!ensureSignedIn()) return;
  pendingClaim = { r, btn };
  $("#claim-confirm-text").textContent =
    r.price != null ? `Claim "${r.title}" for ${fmt(r.price)} pts?` : `Claim "${r.title}"?`;
  $("#claim-confirm-modal").hidden = false;
}

function closeClaimConfirmModal() {
  $("#claim-confirm-modal").hidden = true;
  pendingClaim = null;
}

$("#claim-confirm-cancel").addEventListener("click", closeClaimConfirmModal);
$("#claim-confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "claim-confirm-modal") closeClaimConfirmModal(); // click on the backdrop
});

$("#claim-confirm-submit").addEventListener("click", async () => {
  if (!pendingClaim) return;
  const { r, btn } = pendingClaim;
  closeClaimConfirmModal();
  await performBuy(r, btn);
});

async function performBuy(r, btn) {
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
    markOwnedInCachedLists(r.article);
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

/* ================= loot box ================= */

let lootboxCost = 5000; // refreshed from /api/lootbox; this is just the initial guess shown before that resolves
const lootboxCostText = () => (lootboxCost > 0 ? `${fmt(lootboxCost)} pts` : "Free");

function renderLootboxPage() {
  $("#lootbox-signedout").hidden = !authIsSignedOut();
  $("#lootbox-content").hidden = !state.user;
  $("#lootbox-error").hidden = true;
  $("#lootbox-result").hidden = true;
  if (!state.user) return;

  $("#lootbox-cost").textContent = lootboxCostText();
  if (state.me) $("#lootbox-balance").textContent = fmt(state.me.user.credits);

  const btn = $("#lootbox-open-btn");
  btn.disabled = false;
  btn.textContent = "Open Loot Box";
}

api("/api/lootbox")
  .then((res) => {
    lootboxCost = res.cost;
    if (state.route.page === "lootbox") $("#lootbox-cost").textContent = lootboxCostText();
  })
  .catch(() => {});

$("#lootbox-open-btn").addEventListener("click", async () => {
  if (!ensureSignedIn()) return;
  const btn = $("#lootbox-open-btn");
  const box = $("#lootbox-box");
  btn.disabled = true;
  btn.textContent = "Opening…";
  $("#lootbox-error").hidden = true;
  $("#lootbox-result").hidden = true;
  box.classList.add("lootbox-shake");
  try {
    const res = await api("/api/lootbox", { method: "POST" });
    const h = res.holding;
    $("#lootbox-result-title").textContent = h.displayTitle;
    const diff = res.marketValue - res.cost;
    const diffText =
      diff > 0
        ? `worth ${fmt(res.marketValue)} pts — ${fmt(diff)} pts more than you paid`
        : diff < 0
          ? `worth ${fmt(res.marketValue)} pts — ${fmt(-diff)} pts less than you paid`
          : `worth exactly what you paid`;
    const paidText = res.cost > 0 ? `Paid ${fmt(res.cost)} pts.` : "Free pull.";
    $("#lootbox-result-detail").textContent = `${paidText} This article is ${diffText}.`;
    $("#lootbox-result-view").href = `https://en.wikipedia.org/wiki/${h.article}`;
    $("#lootbox-result-portfolio").href = `#/article/${encodeURIComponent(h.article)}`;
    $("#lootbox-result").hidden = false;
    toast(`Claimed "${h.displayTitle}" from your loot box.`);
    await refreshAfterTrade();
    if (state.me) $("#lootbox-balance").textContent = fmt(state.me.user.credits);
  } catch (err) {
    $("#lootbox-error").textContent = err.message;
    $("#lootbox-error").hidden = false;
  } finally {
    box.classList.remove("lootbox-shake");
    btn.disabled = false;
    btn.textContent = "Open Loot Box";
  }
});

/* ================= list-price modal ================= */
// Replaces a native prompt() with an in-app modal for choosing an asking
// price when listing a held article for resale.

let pendingListing = null; // { holdingId, title } while the modal is open

function openListPriceModal(holdingId, title, currentMarketPrice) {
  pendingListing = { holdingId, title };
  $("#list-price-hint").textContent =
    `List "${title}" for sale on the secondary market. Current market price: ${fmt(currentMarketPrice)} pts.`;
  $("#list-price-input").value = String(Math.round(currentMarketPrice));
  $("#list-price-error").hidden = true;
  $("#list-price-modal").hidden = false;
  $("#list-price-input").focus();
}

function closeListPriceModal() {
  $("#list-price-modal").hidden = true;
  pendingListing = null;
}

$("#list-price-cancel").addEventListener("click", closeListPriceModal);
$("#list-price-modal").addEventListener("click", (e) => {
  if (e.target.id === "list-price-modal") closeListPriceModal(); // click on the backdrop
});

$("#list-price-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingListing) return;
  const { holdingId, title } = pendingListing;
  const errorEl = $("#list-price-error");
  const submitBtn = $("#list-price-submit");
  errorEl.hidden = true;

  const askPrice = Number($("#list-price-input").value);
  if (!Number.isFinite(askPrice) || askPrice < 1) {
    errorEl.textContent = "Enter a valid asking price.";
    errorEl.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  try {
    const res = await api("/api/listings", {
      method: "POST",
      body: JSON.stringify({ holdingId, askPrice }),
    });
    closeListPriceModal();
    toast(`Listed "${title}" for ${fmt(res.listing.askPrice)} pts.`);
    await refreshAfterTrade();
    if (state.route.page === "article" && state.detail) {
      renderArticlePage(state.detail.article);
    } else {
      renderRoute();
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

async function listHolding(holdingId, title, currentMarketPrice) {
  if (!ensureSignedIn()) return;
  openListPriceModal(holdingId, title, currentMarketPrice);
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
  const guessEl = $("#predict-guess");
  const stakeEl = $("#predict-stake");
  if (!guessEl || !stakeEl) return;
  const guess = Number(guessEl.value);
  const stake = Number(stakeEl.value);
  const valid = Number.isFinite(guess) && guess >= 0 && Number.isFinite(stake) && stake >= 1;
  $("#predict-submit").disabled = !valid;
}

function resetPredictForm() {
  const guessEl = $("#predict-guess");
  const stakeEl = $("#predict-stake");
  if (guessEl) guessEl.value = "";
  if (stakeEl) stakeEl.value = "";
  $("#predict-error").textContent = "";
  updatePredictSubmitState();
}

$("#predict-guess").addEventListener("input", updatePredictSubmitState);
$("#predict-stake").addEventListener("input", updatePredictSubmitState);

$("#predict-submit").addEventListener("click", async () => {
  if (!ensureSignedIn()) return;
  const d = state.detail;
  if (!d) return;
  const guess = Number($("#predict-guess").value);
  const stake = Number($("#predict-stake").value);
  const btn = $("#predict-submit");
  const errEl = $("#predict-error");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Placing…";
  try {
    const res = await api("/api/bet", {
      method: "POST",
      body: JSON.stringify({ article: d.article, displayTitle: d.displayTitle, guess, stake }),
    });
    state.bets = res.bets;
    state.me = res.portfolio;
    state.user = res.portfolio.user;
    renderChrome();
    toast(`Predicted "${d.displayTitle}" at ${fmt(guess)} views — staked ${fmt(stake)} pts.`);
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

// Charts are drawn to fill their container's exact size at render time (see
// chartDims) - a window resize changes that size, so without this a chart
// drawn before the resize stays stretched relative to its now-wrong viewBox.
// Redraws from already-fetched data - no network call - and only for
// whichever chart is actually on screen right now.
let resizeRedrawTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = setTimeout(() => {
    const page = state.route.page;
    if (page === "overview" && state.overviewChartHistory?.length) {
      const dims = chartDims("ov-chart");
      $("#ov-chart").innerHTML = bigChartSvg(state.overviewChartHistory, "gradOverview", dims.width, dims.height);
    } else if (page === "points") {
      renderPointsChart();
    } else if (page === "article" && state.detailChartHistory?.length) {
      const dims = chartDims("det-chart");
      $("#det-chart").innerHTML = bigChartSvg(state.detailChartHistory, "gradDetail", dims.width, dims.height);
    }
  }, 150);
});

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
  state.authStatus = "error";
  renderAuthChrome();
  renderRoute();
  toast("Couldn't load sign-in — you can still browse.", true);
});

// Auto-show the getting-started tour once per browser, after the page has
// had a moment to settle. Skipped if the mandatory username modal is
// already up (a brand-new sign-up) so the two don't stack.
setTimeout(() => {
  try {
    if (localStorage.getItem(TOUR_SEEN_KEY)) return;
    if (!$("#username-modal").hidden) return;
    openTour();
  } catch {
    /* localStorage unavailable (e.g. private browsing) - just skip auto-show */
  }
}, 800);
