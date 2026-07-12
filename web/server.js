import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Anchor to this file's own directory, not process.cwd() - Railway runs
// `npm start` from the repo root (per the monorepo package.json), which
// would make dotenv's default cwd-relative lookup miss web/.env entirely.
// Railway itself injects env vars directly, so this is a no-op there either
// way; it's what makes `cd web && npm start` work for local dev.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

import express from "express";
import rateLimit from "express-rate-limit";
import { createClerkClient, verifyToken } from "@clerk/backend";

import { store, uid, initStore } from "./store.js";
import {
  startingCredits,
  portfolio,
  portfolioHistory,
  buyPage,
  sellPage,
  leaderboard,
  recentActivity,
  logEvent,
  placeBet,
  listBets,
  pointsSummary,
  listForSale,
  cancelListing,
  browseListings,
  buyListing,
  publicUser,
} from "./game.js";
import {
  searchArticles,
  getPagePrice,
  getPageMeta,
  getTrending,
  getArticleHistory,
  getCategoryIndexes,
  getRandomArticles,
  getCategoryMembers,
  suggestCategories,
} from "./wikimedia.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.warn(
    "CLERK_SECRET_KEY is not set - every request will be treated as signed out, " +
      "so no one will be able to sign in or transact. Set it in web/.env locally " +
      "(see .env.example) and in your Railway service's Variables in production."
  );
}
const clerkClient = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY }) : null;

const app = express();
// Railway sits exactly one reverse proxy in front of this process - trust
// that one hop's X-Forwarded-For so req.ip (and therefore rate limiting) is
// the real client, not Railway's edge. Trusting further/unlimited hops would
// let a client spoof its own IP via the header and dodge the limits below.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// A single client (or script) hammering the API can't get more Wikimedia
// traffic through than the existing concurrency cap in wikimedia.js allows
// (see withPageviewsLimit), but nothing stopped them from queuing unlimited
// work on *our* server - this is about protecting our own process, not
// Wikimedia's rate limit specifically. General ceiling on all API traffic,
// plus a tighter one below for the routes that always do a live, uncached
// Wikimedia fetch (the ones actually worth abusing).
app.use(
  "/api",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  })
);
const forcedFetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - try again in a minute." },
});
// Each /api/discover hit fans out to ~20-24 Wikimedia price lookups (cache
// absorbs repeats), so it's capped more tightly than a plain read but still
// loose enough for someone rapidly hitting "Shuffle".
const discoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - try again in a minute." },
});

// --- Clerk auth middleware ---
// The frontend sends the Clerk session token as a Bearer header (see api()
// in app.js). We verify it against Clerk, then map the Clerk user to our own
// internal user record - creating one on first sight (just-in-time
// provisioning), since Clerk owns identity but we still track our own
// credits/holdings/bets keyed by our own id everywhere else in the app.
// Verify a Clerk bearer token, returning { clerkUserId } or { reason } so
// both the auth middleware and the /api/debug/auth endpoint can share the
// exact same logic and error wording.
async function verifyClerkToken(bearerToken) {
  if (!bearerToken) return { reason: "no-token" };
  if (!CLERK_SECRET_KEY) return { reason: "no-secret-key" };
  try {
    const result = await verifyToken(bearerToken, { secretKey: CLERK_SECRET_KEY });
    // Confirmed empirically (the .d.ts types this as {data}|{errors}, but
    // that's not what actually comes back at runtime in this installed
    // version): a successful result has the JWT claims directly on the
    // object (result.sub, result.iss, ...), not wrapped in result.data. An
    // errored result has result.errors. Support both shapes defensively
    // since the wrapped form is still what's documented.
    if (result?.errors) {
      return { reason: "rejected", detail: result.errors[0]?.message || String(result.errors) };
    }
    const sub = result?.sub ?? result?.data?.sub;
    if (!sub) {
      return { reason: "no-sub", detail: `raw=${JSON.stringify(result)}` };
    }
    return { clerkUserId: sub };
  } catch (err) {
    return { reason: "threw", detail: err?.message || String(err) };
  }
}

async function resolveUserFromToken(bearerToken) {
  const { clerkUserId, reason, detail } = await verifyClerkToken(bearerToken);
  if (!clerkUserId) {
    // "no-token" is the normal signed-out case (the app polls /api/me on load
    // before sign-in) - don't spam logs for it. Everything else is a real
    // misconfiguration worth surfacing.
    if (reason !== "no-token") {
      console.error(`Clerk auth failed (${reason})${detail ? ": " + detail : ""}`);
    }
    return null;
  }

  const existing = await store.findUserByClerkId(clerkUserId);
  if (existing) return existing;

  // First time we've seen this Clerk user - provision our internal record.
  let displayName = `trader_${clerkUserId.slice(-6)}`;
  try {
    const profile = await clerkClient.users.getUser(clerkUserId);
    displayName =
      profile.username ||
      profile.firstName ||
      profile.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
      displayName;
  } catch (err) {
    console.error("Failed to fetch Clerk profile for", clerkUserId, err);
  }

  const { user, created } = await store.createUserIfNotExists({
    id: uid(),
    clerkUserId,
    username: displayName,
    credits: startingCredits(),
    createdAt: Date.now(),
    needsUsername: true,
  });
  if (created) await logEvent(user.id, "join", {});
  return user;
}

app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  resolveUserFromToken(bearerToken)
    .then((user) => {
      req.userId = user ? user.id : null;
      next();
    })
    .catch(next);
});

const requireAuth = (req, res, next) => {
  if (!req.userId) return res.status(401).json({ error: "Not signed in." });
  next();
};

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message || "Something went wrong." });
  });

// Diagnostic endpoint - reports exactly why auth did or didn't succeed,
// without leaking the token or secret. Visit /api/debug/auth in the browser
// while signed in to see what's actually happening end-to-end. The one
// real use case is a signed-in user whose Clerk session the backend can't
// verify, so it's only useful (and only responds) when a bearer token was
// actually sent - a blind, tokenless probe gets a 404, not a peek at the
// server's auth-configuration state.
app.get(
  "/api/debug/auth",
  wrap(async (req, res) => {
    const auth = req.headers.authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    if (!hasBearer) return res.status(404).end();
    const bearerToken = auth.slice(7);
    const result = await verifyClerkToken(bearerToken);
    res.json({
      // What the browser sent us:
      authorizationHeaderPresent: !!auth,
      looksLikeBearer: hasBearer,
      tokenLength: bearerToken ? bearerToken.length : 0,
      // What the server is configured with:
      secretKeyConfigured: !!CLERK_SECRET_KEY,
      secretKeyPrefix: CLERK_SECRET_KEY ? CLERK_SECRET_KEY.slice(0, 8) : null,
      // The verification outcome:
      verified: !!result.clerkUserId,
      reason: result.reason || "ok",
      detail: result.detail || null,
    });
  })
);

// Price fields for API responses. When the pageviews window came back empty
// ("unpriced"), send nulls so the UI shows "no data" instead of a bogus 1.
function pricePayload(p) {
  if (p.unpriced) {
    return {
      price: null,
      changePct: null,
      changePct30d: null,
      changePctYear: null,
      latestViews: null,
      spark: null,
      unpriced: true,
      pendingLatest: false,
    };
  }
  return {
    price: p.annualPrice,
    changePct: p.changePct,
    changePct30d: p.changePct30d,
    changePctYear: p.changePctYear,
    latestViews: p.latestViews,
    spark: p.spark || null,
    unpriced: false,
    pendingLatest: !!p.pendingLatest,
  };
}

// Open + resolved bets, each decorated with a thumbnail for display.
async function bundledBets(userId) {
  const { open, resolved } = await listBets(userId);
  return { open: await attachMeta(open), resolved: await attachMeta(resolved) };
}

// Decorate a list of items (each with .article) with thumbnail + description.
async function attachMeta(items) {
  const meta = await getPageMeta(items.map((i) => i.article));
  return items.map((i) => ({
    ...i,
    thumbnail: meta.get(i.article)?.thumbnail ?? null,
    description: meta.get(i.article)?.description ?? null,
  }));
}

// Decorate a list of items (each with .article) with exclusive-ownership
// status, so the UI can show "Claim" only for genuinely unowned articles and
// route to the secondary-market listing (if any) otherwise.
async function attachOwnership(items, userId) {
  return Promise.all(
    items.map(async (i) => {
      const owner = await store.findAnyHolding("en.wikipedia", i.article);
      if (!owner) return { ...i, owned: false, ownedByMe: false, listing: null };
      const listing = await store.getListing(owner.id);
      return {
        ...i,
        owned: true,
        ownedByMe: owner.userId === userId,
        listing: listing ? { id: listing.id, askPrice: listing.askPrice } : null,
      };
    })
  );
}

// --- game routes ---
app.get(
  "/api/me",
  wrap(async (req, res) => {
    if (!req.userId) return res.json({ user: null });
    const p = await portfolio(req.userId);
    p.holdings = await attachMeta(p.holdings);
    // Portfolio rank = position on the net-worth leaderboard.
    const rows = await leaderboard();
    const rank = rows.findIndex((r) => r.id === p.user.id) + 1;
    p.rank = rank || null;
    p.totalPlayers = rows.length;
    res.json(p);
  })
);

// Mandatory post-signup step: every newly-provisioned account starts with
// needsUsername=true and an auto-generated placeholder name (from Clerk
// profile data or a trader_XXXXXX fallback) until they set a real one here.
app.post(
  "/api/username",
  requireAuth,
  wrap(async (req, res) => {
    const username = String(req.body.username || "").trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new Error("Username must be 3-20 characters: letters, numbers, and underscores only.");
    }
    const updated = await store.setUsername(req.userId, username);
    if (!updated) throw new Error("That username is already taken.");
    res.json({ user: publicUser(updated) });
  })
);

app.get(
  "/api/search",
  wrap(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    const results = await searchArticles(q);
    // Attach current price to each result so the UI can show cost up front.
    const priced = await Promise.all(
      results.map(async (r) => {
        try {
          const p = await getPagePrice("en.wikipedia", r.article);
          return { ...r, ...pricePayload(p) };
        } catch {
          return { ...r, price: null, changePct: null, changePct30d: null, changePctYear: null, latestViews: null, spark: null, unpriced: true, pendingLatest: false };
        }
      })
    );
    res.json({ results: await attachOwnership(await attachMeta(priced), req.userId) });
  })
);

app.get(
  "/api/trending",
  wrap(async (req, res) => {
    res.json({
      items: await attachOwnership(await attachMeta(await getTrending(20)), req.userId),
    });
  })
);

app.get(
  "/api/categories",
  wrap(async (req, res) => {
    res.json({ categories: await getCategoryIndexes() });
  })
);

// Exploration feed for browsing articles without a search term: a random
// batch of Wikipedia articles, or (with ?category=) real members of an
// actual Wikipedia category - not the small curated CATEGORY_BASKETS used
// for the trending-page summary tiles.
app.get(
  "/api/discover",
  discoverLimiter,
  wrap(async (req, res) => {
    const category = String(req.query.category || "").trim();
    const candidates = category
      ? await getCategoryMembers(category, 24)
      : await getRandomArticles(20);
    const priced = await Promise.all(
      candidates.map(async (c) => {
        try {
          const p = await getPagePrice("en.wikipedia", c.article);
          return { ...c, ...pricePayload(p) };
        } catch {
          return { ...c, price: null, changePct: null, changePct30d: null, changePctYear: null, latestViews: null, spark: null, unpriced: true, pendingLatest: false };
        }
      })
    );
    res.json({ items: await attachOwnership(await attachMeta(priced), req.userId) });
  })
);

// Autocomplete for the Discover page's custom category search - just real
// Wikipedia category names, no pricing involved, so it rides the general
// /api rate limiter rather than needing its own.
app.get(
  "/api/category-suggest",
  wrap(async (req, res) => {
    const q = String(req.query.q || "");
    res.json({ categories: await suggestCategories(q) });
  })
);

app.get(
  "/api/history",
  wrap(async (req, res) => {
    const article = String(req.query.article || "");
    if (!article) throw new Error("Missing article.");
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const history = await getArticleHistory("en.wikipedia", article, days);
    res.json({ history });
  })
);

app.get(
  "/api/portfolio-history",
  requireAuth,
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    res.json({ history: await portfolioHistory(req.userId, days) });
  })
);

// Everything a detail page needs for one article, in one call. Public - the
// per-user fields (holding/watched) just come back null/false when signed out.
app.get(
  "/api/article",
  wrap(async (req, res) => {
    const article = String(req.query.article || "");
    if (!article) throw new Error("Missing article.");
    const project = "en.wikipedia";

    const price = await getPagePrice(project, article);
    const [metaMap, holding, watched, anyOwner] = await Promise.all([
      getPageMeta([article]),
      store.findHolding(req.userId, project, article),
      store.isWatched(req.userId, project, article),
      store.findAnyHolding(project, article),
    ]);
    const meta = metaMap.get(article) || {};
    const listing = anyOwner ? await store.getListing(anyOwner.id) : null;

    res.json({
      article,
      displayTitle: article.replace(/_/g, " "),
      url: `https://en.wikipedia.org/wiki/${article}`,
      thumbnail: meta.thumbnail ?? null,
      description: meta.description ?? null,
      ...pricePayload(price),
      watched,
      owned: !!anyOwner,
      listing: listing ? { id: listing.id, askPrice: listing.askPrice } : null,
      holding: holding
        ? {
            id: holding.id,
            purchasePrice: holding.purchasePrice,
            purchasedDate: holding.purchasedDate,
            totalEarned: holding.totalEarned || 0,
          }
        : null,
    });
  })
);

// Manual price re-check: force a fresh fetch past the cache. Used by the UI
// when an article shows "no data" (transient Wikimedia API flakiness). Public
// - it busts a shared price cache, not any user-specific data or credits.
app.post(
  "/api/reprice",
  forcedFetchLimiter,
  wrap(async (req, res) => {
    const article = String(req.body.article || "");
    if (!article) throw new Error("Missing article.");
    const p = await getPagePrice("en.wikipedia", article, { force: true });
    res.json({ article, ...pricePayload(p) });
  })
);

app.get(
  "/api/watchlist",
  requireAuth,
  wrap(async (req, res) => {
    const rows = await store.watchlistForUser(req.userId);
    const priced = await Promise.all(
      rows.map(async (w) => {
        try {
          const p = await getPagePrice(w.project, w.article);
          return { article: w.article, displayTitle: w.displayTitle, ...pricePayload(p) };
        } catch {
          return { article: w.article, displayTitle: w.displayTitle, price: null, changePct: null, changePct30d: null, changePctYear: null, latestViews: null, spark: null, unpriced: true, pendingLatest: false };
        }
      })
    );
    res.json({ items: await attachOwnership(await attachMeta(priced), req.userId) });
  })
);

app.post(
  "/api/watchlist/toggle",
  requireAuth,
  wrap(async (req, res) => {
    const article = String(req.body.article || "");
    const displayTitle = String(req.body.displayTitle || article.replace(/_/g, " "));
    if (!article) throw new Error("Missing article.");
    const project = "en.wikipedia";

    if (await store.isWatched(req.userId, project, article)) {
      await store.removeWatch(req.userId, project, article);
      return res.json({ watched: false });
    }
    await store.addWatch({
      userId: req.userId,
      project,
      article,
      displayTitle,
      addedAt: Date.now(),
    });
    res.json({ watched: true });
  })
);

app.get(
  "/api/activity",
  wrap(async (req, res) => {
    res.json({ events: await recentActivity(40) });
  })
);

app.post(
  "/api/buy",
  requireAuth,
  forcedFetchLimiter,
  wrap(async (req, res) => {
    const article = String(req.body.article || "");
    const displayTitle = String(req.body.displayTitle || article.replace(/_/g, " "));
    if (!article) throw new Error("Missing article.");
    const result = await buyPage(req.userId, {
      project: "en.wikipedia",
      article,
      displayTitle,
      lang: "en",
    });
    res.json({ ...result, portfolio: await portfolio(req.userId) });
  })
);

app.post(
  "/api/sell",
  requireAuth,
  forcedFetchLimiter,
  wrap(async (req, res) => {
    const result = await sellPage(req.userId, String(req.body.holdingId || ""));
    res.json({ ...result, portfolio: await portfolio(req.userId) });
  })
);

// --- secondary market (peer-to-peer resale of exclusively-owned articles) ---
app.get(
  "/api/listings",
  wrap(async (req, res) => {
    res.json({ listings: await attachMeta(await browseListings()) });
  })
);

app.post(
  "/api/listings",
  requireAuth,
  wrap(async (req, res) => {
    const holdingId = String(req.body.holdingId || "");
    if (!holdingId) throw new Error("Missing holdingId.");
    const listing = await listForSale(req.userId, holdingId, req.body.askPrice);
    res.json({ listing, portfolio: await portfolio(req.userId) });
  })
);

app.post(
  "/api/listings/:id/cancel",
  requireAuth,
  wrap(async (req, res) => {
    const result = await cancelListing(req.userId, req.params.id);
    res.json({ ...result, portfolio: await portfolio(req.userId) });
  })
);

app.post(
  "/api/listings/:id/buy",
  requireAuth,
  wrap(async (req, res) => {
    const result = await buyListing(req.userId, req.params.id);
    res.json({ ...result, portfolio: await portfolio(req.userId) });
  })
);

app.post(
  "/api/bet",
  requireAuth,
  forcedFetchLimiter,
  wrap(async (req, res) => {
    const article = String(req.body.article || "");
    const displayTitle = String(req.body.displayTitle || article.replace(/_/g, " "));
    const direction = String(req.body.direction || "");
    const stake = req.body.stake;
    if (!article) throw new Error("Missing article.");
    const result = await placeBet(req.userId, {
      project: "en.wikipedia",
      article,
      displayTitle,
      direction,
      stake,
    });
    res.json({ ...result, bets: await bundledBets(req.userId), portfolio: await portfolio(req.userId) });
  })
);

app.get(
  "/api/bets",
  requireAuth,
  wrap(async (req, res) => {
    res.json(await bundledBets(req.userId));
  })
);

app.get(
  "/api/leaderboard",
  wrap(async (req, res) => {
    res.json({ rows: await leaderboard() });
  })
);

app.get(
  "/api/points",
  requireAuth,
  wrap(async (req, res) => {
    const summary = await pointsSummary(req.userId);
    res.json({ ...summary, history: await attachMeta(summary.history) });
  })
);

initStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WikiClaim running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize store:", err);
    process.exit(1);
  });
