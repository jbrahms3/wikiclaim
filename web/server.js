import express from "express";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { store, uid, token, initStore } from "./store.js";
import {
  startingCredits,
  publicUser,
  portfolio,
  buyPage,
  sellPage,
  leaderboard,
} from "./game.js";
import {
  searchArticles,
  getPagePrice,
  getTrending,
  getArticleHistory,
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
    res.json(await portfolio(req.userId));
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
          return { ...r, price: p.avgViews, changePct: p.changePct };
        } catch {
          return { ...r, price: null, changePct: null };
        }
      })
    );
    res.json({ results: priced });
  })
);

app.get(
  "/api/trending",
  wrap(async (req, res) => {
    res.json({ items: await getTrending() });
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
