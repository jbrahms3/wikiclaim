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
} from "./game.js";
import {
  searchArticles,
  getPagePrice,
  getPageMeta,
  getTrending,
  getArticleHistory,
  getCategoryIndexes,
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
    const { data, errors } = await verifyToken(bearerToken, { secretKey: CLERK_SECRET_KEY });
    // verifyToken reports invalid/expired/mismatched tokens as a normal
    // {errors} return value, not a thrown exception.
    if (errors) return { reason: "rejected", detail: errors[0]?.message || String(errors) };
    if (!data?.sub) {
      // This shouldn't be reachable - Clerk's own claim validation rejects a
      // token with no `sub` as an error, not a success. Dump the actual shape
      // so we can see what's really coming back instead of guessing further.
      return { reason: "no-sub", detail: JSON.stringify(data) };
    }
    return { clerkUserId: data.sub };
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

  const user = await store.createUser({
    id: uid(),
    clerkUserId,
    username: displayName,
    credits: startingCredits(),
    createdAt: Date.now(),
  });
  await logEvent(user.id, "join", {});
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
// while signed in to see what's actually happening end-to-end.
app.get(
  "/api/debug/auth",
  wrap(async (req, res) => {
    const auth = req.headers.authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const bearerToken = hasBearer ? auth.slice(7) : null;
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
    return { price: null, changePct: null, latestViews: null, spark: null, unpriced: true };
  }
  return {
    price: p.avgViews,
    changePct: p.changePct,
    latestViews: p.latestViews,
    spark: p.spark || null,
    unpriced: false,
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

app.get(
  "/api/search",
  requireAuth,
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
          return { ...r, price: null, changePct: null, latestViews: null, spark: null, unpriced: true };
        }
      })
    );
    res.json({ results: await attachMeta(priced) });
  })
);

app.get(
  "/api/trending",
  wrap(async (req, res) => {
    res.json({ items: await attachMeta(await getTrending(20)) });
  })
);

app.get(
  "/api/categories",
  wrap(async (req, res) => {
    res.json({ categories: await getCategoryIndexes() });
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

// Everything a detail page needs for one article, in one call.
app.get(
  "/api/article",
  requireAuth,
  wrap(async (req, res) => {
    const article = String(req.query.article || "");
    if (!article) throw new Error("Missing article.");
    const project = "en.wikipedia";

    const price = await getPagePrice(project, article);
    const [metaMap, holding, watched] = await Promise.all([
      getPageMeta([article]),
      store.findHolding(req.userId, project, article),
      store.isWatched(req.userId, project, article),
    ]);
    const meta = metaMap.get(article) || {};

    res.json({
      article,
      displayTitle: article.replace(/_/g, " "),
      url: `https://en.wikipedia.org/wiki/${article}`,
      thumbnail: meta.thumbnail ?? null,
      description: meta.description ?? null,
      ...pricePayload(price),
      watched,
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
// when an article shows "no data" (transient Wikimedia API flakiness).
app.post(
  "/api/reprice",
  requireAuth,
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
          return { article: w.article, displayTitle: w.displayTitle, price: null, changePct: null, latestViews: null, spark: null, unpriced: true };
        }
      })
    );
    res.json({ items: await attachMeta(priced) });
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
  wrap(async (req, res) => {
    const result = await sellPage(req.userId, String(req.body.holdingId || ""));
    res.json({ ...result, portfolio: await portfolio(req.userId) });
  })
);

app.post(
  "/api/bet",
  requireAuth,
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
