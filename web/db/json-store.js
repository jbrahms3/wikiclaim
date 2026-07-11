// JSON-file-backed store. Used for local development when DATABASE_URL is not
// set. In-memory state persisted to disk on every mutation. No native deps.
//
// Implements the same async interface as pg-store.js so game/server code is
// backend-agnostic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY = {
  users: {},
  holdings: {},
  pageCache: {},
  watchlist: {}, // "userId::project::article" -> { userId, project, article, displayTitle, addedAt }
  activity: [], // newest last; capped
  bets: {}, // id -> 24h directional price prediction, see game.js placeBet
  listings: {}, // id (== holding id) -> secondary market listing, see game.js listForSale
};

// Records are flat objects; return shallow copies from reads so callers can't
// accidentally mutate stored state by reference (matches the Postgres backend,
// which always returns fresh row objects).
const copy = (o) => (o ? { ...o } : o);

function load() {
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

let db = load();

let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(() => {
    writeQueued = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_PATH);
    } catch (err) {
      console.error("Failed to persist DB:", err);
    }
  });
}

export function createJsonStore() {
  return {
    kind: "json",

    async init() {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    },

    // --- users ---
    async getUser(id) {
      return copy(db.users[id]) || null;
    },
    async findUserByName(username) {
      return (
        copy(
          Object.values(db.users).find(
            (u) => u.username.toLowerCase() === username.toLowerCase()
          )
        ) || null
      );
    },
    async findUserByClerkId(clerkUserId) {
      return (
        copy(Object.values(db.users).find((u) => u.clerkUserId === clerkUserId)) || null
      );
    },
    async allUsers() {
      return Object.values(db.users).map(copy);
    },
    async createUser(user) {
      db.users[user.id] = user;
      persist();
      return user;
    },
    // Atomically subtract `amount` iff the balance can cover it.
    // Returns the new balance, or null if funds are insufficient.
    async tryDebit(userId, amount) {
      const u = db.users[userId];
      if (!u || u.credits < amount) return null;
      u.credits -= amount;
      persist();
      return u.credits;
    },
    async addCredits(userId, delta) {
      const u = db.users[userId];
      if (!u) return null;
      u.credits += delta;
      persist();
      return u.credits;
    },

    // --- holdings ---
    async holdingsForUser(userId) {
      return Object.values(db.holdings)
        .filter((h) => h.userId === userId)
        .map(copy);
    },
    async findHolding(userId, project, article) {
      return (
        copy(
          Object.values(db.holdings).find(
            (h) => h.userId === userId && h.project === project && h.article === article
          )
        ) || null
      );
    },
    async findAnyHolding(project, article) {
      return (
        copy(
          Object.values(db.holdings).find(
            (h) => h.project === project && h.article === article
          )
        ) || null
      );
    },
    async getHolding(id) {
      return copy(db.holdings[id]) || null;
    },
    async createHolding(h) {
      db.holdings[h.id] = { ...h };
      persist();
      return h;
    },
    // Compare-and-set settlement: only apply if lastSettledDate is unchanged,
    // so two concurrent settlements can't double-credit. Returns true if applied.
    async applySettlement(id, expectedLast, newLast, earnedDelta) {
      const h = db.holdings[id];
      if (!h || h.lastSettledDate !== expectedLast) return false;
      h.lastSettledDate = newLast;
      h.totalEarned = (h.totalEarned || 0) + earnedDelta;
      persist();
      return true;
    },
    async deleteHolding(id) {
      delete db.holdings[id];
      persist();
    },

    // --- page price cache ---
    async getPageCache(key) {
      return copy(db.pageCache[key]) || null;
    },
    async setPageCache(entry) {
      db.pageCache[entry.key] = { ...entry };
      persist();
      return entry;
    },

    // --- watchlist ---
    async watchlistForUser(userId) {
      return Object.values(db.watchlist)
        .filter((w) => w.userId === userId)
        .sort((a, b) => b.addedAt - a.addedAt)
        .map(copy);
    },
    async isWatched(userId, project, article) {
      return !!db.watchlist[`${userId}::${project}::${article}`];
    },
    async addWatch(entry) {
      db.watchlist[`${entry.userId}::${entry.project}::${entry.article}`] = { ...entry };
      persist();
    },
    async removeWatch(userId, project, article) {
      delete db.watchlist[`${userId}::${project}::${article}`];
      persist();
    },

    // --- activity feed ---
    async logActivity(event) {
      db.activity.push({ ...event });
      if (db.activity.length > 300) db.activity = db.activity.slice(-300);
      persist();
    },
    async recentActivity(limit) {
      return db.activity.slice(-limit).reverse().map(copy);
    },
    async activityForUser(userId, limit) {
      return db.activity
        .filter((e) => e.userId === userId)
        .slice(-limit)
        .reverse()
        .map(copy);
    },

    // --- bets (24h directional price predictions) ---
    async createBet(bet) {
      db.bets[bet.id] = { ...bet };
      persist();
      return bet;
    },
    async betsForUser(userId, status) {
      return Object.values(db.bets)
        .filter((b) => b.userId === userId && (!status || b.status === status))
        .sort((a, b) => b.placedAt - a.placedAt)
        .map(copy);
    },
    // Compare-and-set: only resolves an still-open bet, so a concurrent
    // settle pass can't double-pay it. Returns true if applied.
    async resolveBet(id, updates) {
      const b = db.bets[id];
      if (!b || b.status !== "open") return false;
      Object.assign(b, updates, { status: "resolved" });
      persist();
      return true;
    },

    // --- listings (secondary market) ---
    async createListing(listing) {
      db.listings[listing.id] = { ...listing };
      persist();
      return listing;
    },
    async getListing(id) {
      return copy(db.listings[id]) || null;
    },
    async allActiveListings() {
      return Object.values(db.listings).map(copy);
    },
    async claimListing(id) {
      const l = db.listings[id];
      if (!l) return null;
      delete db.listings[id];
      persist();
      return copy(l);
    },
  };
}
