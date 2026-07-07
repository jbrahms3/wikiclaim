import express from "express";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { store, uid, token, initStore } from "./store.js";
import {
  startingCredits,
  publicUser,
  portfolio,
  portfolioHistory,
  buyPage,
  sellPage,
  leaderboard,
  recentActivity,
  logEvent,
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
const COOKIE = "wc_session";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- minimal cookie parsing / auth middleware ---
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  const t = parseCookies(req)[COOKIE];
  Promise.resolve(t ? store.userIdForToken(t) : null)
    .then((userId) => {
      req.userId = userId;
      next();
    })
    .catch(next);
});

const requireAuth = (req, res, next) => {
  Promise.resolve(req.userId ? store.getUser(req.userId) : null)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "Not signed in." });
      next();
    })
    .catch(next);
};

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
  );
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message || "Something went wrong." });
  });

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

// Decorate a list of items (each with .article) with thumbnail + description.
async function attachMeta(items) {
  const meta = await getPageMeta(items.map((i) => i.article));
  return items.map((i) => ({
    ...i,
    thumbnail: meta.get(i.article)?.thumbnail ?? null,
    description: meta.get(i.article)?.description ?? null,
  }));
}

// --- auth routes ---
app.post(
  "/api/register",
  wrap(async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (username.length < 3 || username.length > 20) {
      throw new Error("Username must be 3-20 characters.");
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      throw new Error("Username may only contain letters, numbers, and underscores.");
    }
    if (password.length < 6) throw new Error("Password must be at least 6 characters.");
    if (await store.findUserByName(username)) throw new Error("That username is taken.");

    const user = await store.createUser({
      id: uid(),
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      credits: startingCredits(),
      createdAt: Date.now(),
    });
    const t = await store.createSession(token(), user.id);
    setSessionCookie(res, t);
    await logEvent(user.id, "join", {});
    res.json({ user: publicUser(user) });
  })
);

app.post(
  "/api/login",
  wrap(async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = await store.findUserByName(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      throw new Error("Invalid username or password.");
    }
    const t = await store.createSession(token(), user.id);
    setSessionCookie(res, t);
    res.json({ user: publicUser(user) });
  })
);

app.post(
  "/api/logout",
  wrap(async (req, res) => {
    const t = parseCookies(req)[COOKIE];
    if (t) await store.destroySession(t);
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  })
);

// --- game routes ---
app.get(
  "/api/me",
  wrap(async (req, res) => {
    if (!req.userId || !(await store.getUser(req.userId))) {
      return res.json({ user: null });
    }
    const p = await portfolio(req.userId);
    p.holdings = await attachMeta(p.holdings);
    // Portfolio rank = position on the net-worth leaderboard.
    const rows = await leaderboard();
    const rank = rows.findIndex((r) => r.username === p.user.username) + 1;
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
    res.json({ items: await attachMeta(await getTrending()) });
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
