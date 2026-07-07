// Tiny JSON-file-backed data store. No native dependencies, so it installs
// cleanly everywhere. The whole DB lives in memory and is persisted to disk on
// every mutation (synchronous, atomic-ish via write-to-temp + rename).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY = {
  users: {}, // id -> { id, username, passwordHash, credits, createdAt }
  holdings: {}, // id -> { id, userId, project, article, displayTitle, lang, purchasePrice, purchasedDate, lastSettledDate, totalEarned }
  sessions: {}, // token -> userId
  pageCache: {}, // key -> { key, displayTitle, avgViews, updatedAt }
};

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    return structuredClone(EMPTY);
  }
}

let db = load();

let writeQueued = false;
function persist() {
  // Coalesce bursts of writes within a tick into a single disk flush.
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

export const uid = () => crypto.randomUUID();
export const token = () => crypto.randomBytes(24).toString("hex");

export const store = {
  // --- users ---
  getUser: (id) => db.users[id] || null,
  findUserByName: (username) =>
    Object.values(db.users).find(
      (u) => u.username.toLowerCase() === username.toLowerCase()
    ) || null,
  allUsers: () => Object.values(db.users),
  saveUser(user) {
    db.users[user.id] = user;
    persist();
    return user;
  },

  // --- sessions ---
  createSession(userId) {
    const t = token();
    db.sessions[t] = userId;
    persist();
    return t;
  },
  userIdForToken: (t) => db.sessions[t] || null,
  destroySession(t) {
    delete db.sessions[t];
    persist();
  },

  // --- holdings ---
  holdingsForUser: (userId) =>
    Object.values(db.holdings).filter((h) => h.userId === userId),
  findHolding: (userId, project, article) =>
    Object.values(db.holdings).find(
      (h) =>
        h.userId === userId && h.project === project && h.article === article
    ) || null,
  getHolding: (id) => db.holdings[id] || null,
  saveHolding(h) {
    db.holdings[h.id] = h;
    persist();
    return h;
  },
  deleteHolding(id) {
    delete db.holdings[id];
    persist();
  },

  // --- page price cache ---
  getPageCache: (key) => db.pageCache[key] || null,
  setPageCache(entry) {
    db.pageCache[entry.key] = entry;
    persist();
    return entry;
  },
};
