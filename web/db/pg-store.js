// Postgres-backed store. Used when DATABASE_URL is set (e.g. on Railway).
// Implements the same async interface as json-store.js.
import pg from "pg";

// BIGINT (oid 20) and NUMERIC (1700) come back as strings by default to avoid
// precision loss. Our values stay well within Number's safe range, so parse
// them to numbers for convenient arithmetic.
function installTypeParsers(pgModule) {
  pgModule.types?.setTypeParser?.(20, (v) => (v === null ? null : parseInt(v, 10)));
  pgModule.types?.setTypeParser?.(1700, (v) => (v === null ? null : parseFloat(v)));
}
installTypeParsers(pg);

function sslConfig(connectionString) {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.DATABASE_SSL === "true") return { rejectUnauthorized: false };
  // Auto: local and Railway's private network don't use SSL; anything else does.
  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".railway.internal")) {
      return false;
    }
  } catch {
    /* fall through */
  }
  return { rejectUnauthorized: false };
}

const rowToUser = (r) =>
  r
    ? {
        id: r.id,
        username: r.username,
        clerkUserId: r.clerk_user_id,
        credits: r.credits,
        createdAt: r.created_at,
      }
    : null;

const rowToHolding = (r) =>
  r
    ? {
        id: r.id,
        userId: r.user_id,
        project: r.project,
        article: r.article,
        displayTitle: r.display_title,
        lang: r.lang,
        key: r.key,
        purchasePrice: r.purchase_price,
        purchasedDate: r.purchased_date,
        lastSettledDate: r.last_settled_date,
        totalEarned: r.total_earned,
      }
    : null;

const rowToActivity = (r) =>
  r
    ? {
        id: r.id,
        ts: r.ts,
        type: r.type,
        userId: r.user_id,
        username: r.username,
        article: r.article,
        displayTitle: r.display_title,
        amount: r.amount,
      }
    : null;

// Predictions resolve against daily views now, not price (see game.js) - the
// start_price/end_price columns kept their names to avoid a migration, but
// hold view counts, not prices.
const rowToBet = (r) =>
  r
    ? {
        id: r.id,
        userId: r.user_id,
        project: r.project,
        article: r.article,
        displayTitle: r.display_title,
        direction: r.direction,
        stake: r.stake,
        startViews: r.start_price,
        placedAt: r.placed_at,
        resolvesAt: r.resolves_at,
        status: r.status,
        endViews: r.end_price,
        payout: r.payout,
        resolvedAt: r.resolved_at,
      }
    : null;

const rowToListing = (r) =>
  r
    ? {
        id: r.id,
        sellerId: r.seller_id,
        project: r.project,
        article: r.article,
        displayTitle: r.display_title,
        lang: r.lang,
        askPrice: r.ask_price,
        listedAt: r.listed_at,
      }
    : null;

const rowToCache = (r) => {
  if (!r) return null;
  let spark = null;
  try {
    spark = r.spark ? JSON.parse(r.spark) : null;
  } catch {
    /* ignore malformed spark */
  }
  return {
    key: r.key,
    project: r.project,
    article: r.article,
    avgViews: r.avg_views,
    premium: r.premium,
    latestViews: r.latest_views,
    changePct: r.change_pct,
    pendingLatest: r.pending_latest,
    spark,
    windowDays: r.window_days,
    updatedAt: r.updated_at,
  };
};

export function createPgStore({ pgModule = pg, pool: injectedPool } = {}) {
  const connectionString = process.env.DATABASE_URL;
  installTypeParsers(pgModule);
  const pool =
    injectedPool ||
    new pgModule.Pool({ connectionString, ssl: sslConfig(connectionString) });
  const q = (text, params) => pool.query(text, params);

  return {
    kind: "postgres",

    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          password_hash TEXT,
          clerk_user_id TEXT,
          credits BIGINT NOT NULL,
          created_at BIGINT NOT NULL
        );
      `);
      // Case-insensitive uniqueness on username.
      await q(
        `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));`
      );
      // Auth moved from local password accounts to Clerk. password_hash is
      // dead weight kept only so existing rows don't break; new rows never
      // set it. clerk_user_id is the real identity now.
      await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT;`);
      await q(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`);
      await q(
        `CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_user_id_idx ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL;`
      );
      await q(`
        CREATE TABLE IF NOT EXISTS holdings (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          article TEXT NOT NULL,
          display_title TEXT NOT NULL,
          lang TEXT NOT NULL,
          key TEXT NOT NULL,
          purchase_price BIGINT NOT NULL,
          purchased_date TEXT NOT NULL,
          last_settled_date TEXT NOT NULL,
          total_earned BIGINT NOT NULL DEFAULT 0,
          UNIQUE (user_id, project, article)
        );
      `);
      await q(
        `CREATE INDEX IF NOT EXISTS holdings_user_idx ON holdings (user_id);`
      );
      await q(`
        CREATE TABLE IF NOT EXISTS page_cache (
          key TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          article TEXT NOT NULL,
          avg_views BIGINT NOT NULL,
          window_days INTEGER NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
      // Columns added after the initial schema shipped; existing deploys pick
      // them up on boot. latest_views/change_pct were previously computed but
      // silently dropped by this store.
      await q(`ALTER TABLE page_cache ADD COLUMN IF NOT EXISTS latest_views BIGINT;`);
      await q(`ALTER TABLE page_cache ADD COLUMN IF NOT EXISTS change_pct DOUBLE PRECISION;`);
      await q(`ALTER TABLE page_cache ADD COLUMN IF NOT EXISTS spark TEXT;`);
      await q(`ALTER TABLE page_cache ADD COLUMN IF NOT EXISTS premium BIGINT;`);
      await q(`ALTER TABLE page_cache ADD COLUMN IF NOT EXISTS pending_latest BOOLEAN;`);
      await q(`
        CREATE TABLE IF NOT EXISTS watchlist (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          article TEXT NOT NULL,
          display_title TEXT NOT NULL,
          added_at BIGINT NOT NULL,
          PRIMARY KEY (user_id, project, article)
        );
      `);
      await q(`
        CREATE TABLE IF NOT EXISTS activity (
          id TEXT PRIMARY KEY,
          ts BIGINT NOT NULL,
          type TEXT NOT NULL,
          username TEXT NOT NULL,
          article TEXT,
          display_title TEXT,
          amount BIGINT
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS activity_ts_idx ON activity (ts DESC);`);
      // Added after the initial schema shipped, so events logged before
      // this need to be nullable - the Points page's history just won't
      // show anything for those (see earningsHistory in game.js).
      await q(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS user_id TEXT;`);
      await q(`CREATE INDEX IF NOT EXISTS activity_user_idx ON activity (user_id, ts DESC);`);
      await q(`
        CREATE TABLE IF NOT EXISTS bets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          article TEXT NOT NULL,
          display_title TEXT NOT NULL,
          direction TEXT NOT NULL,
          stake BIGINT NOT NULL,
          start_price BIGINT NOT NULL,
          placed_at BIGINT NOT NULL,
          resolves_at BIGINT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          end_price BIGINT,
          payout BIGINT,
          resolved_at BIGINT
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS bets_user_idx ON bets (user_id, status);`);
      // Secondary market: a listing's id is its holding's id (a holding can
      // only be listed once at a time), so listing/re-listing is a natural
      // upsert and buying/cancelling is a single atomic delete-and-return.
      await q(`
        CREATE TABLE IF NOT EXISTS listings (
          id TEXT PRIMARY KEY,
          seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          article TEXT NOT NULL,
          display_title TEXT NOT NULL,
          lang TEXT NOT NULL,
          ask_price BIGINT NOT NULL,
          listed_at BIGINT NOT NULL
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS listings_article_idx ON listings (project, article);`);
      // Exclusive ownership needs "does anyone own this article" lookups.
      await q(`CREATE INDEX IF NOT EXISTS holdings_article_idx ON holdings (project, article);`);
    },

    // --- users ---
    async getUser(id) {
      const { rows } = await q(`SELECT * FROM users WHERE id = $1`, [id]);
      return rowToUser(rows[0]);
    },
    async findUserByName(username) {
      const { rows } = await q(
        `SELECT * FROM users WHERE lower(username) = lower($1)`,
        [username]
      );
      return rowToUser(rows[0]);
    },
    async findUserByClerkId(clerkUserId) {
      const { rows } = await q(`SELECT * FROM users WHERE clerk_user_id = $1`, [clerkUserId]);
      return rowToUser(rows[0]);
    },
    async allUsers() {
      const { rows } = await q(`SELECT * FROM users`);
      return rows.map(rowToUser);
    },
    async createUser(user) {
      await q(
        `INSERT INTO users (id, username, clerk_user_id, credits, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, user.username, user.clerkUserId, user.credits, user.createdAt]
      );
      return user;
    },
    async tryDebit(userId, amount) {
      const { rows } = await q(
        `UPDATE users SET credits = credits - $2
         WHERE id = $1 AND credits >= $2
         RETURNING credits`,
        [userId, amount]
      );
      return rows[0] ? rows[0].credits : null;
    },
    async addCredits(userId, delta) {
      const { rows } = await q(
        `UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits`,
        [userId, delta]
      );
      return rows[0] ? rows[0].credits : null;
    },

    // --- holdings ---
    async holdingsForUser(userId) {
      const { rows } = await q(`SELECT * FROM holdings WHERE user_id = $1`, [
        userId,
      ]);
      return rows.map(rowToHolding);
    },
    async findHolding(userId, project, article) {
      const { rows } = await q(
        `SELECT * FROM holdings WHERE user_id = $1 AND project = $2 AND article = $3`,
        [userId, project, article]
      );
      return rowToHolding(rows[0]);
    },
    // Exclusive ownership: is this article owned by anyone at all (any user)?
    async findAnyHolding(project, article) {
      const { rows } = await q(
        `SELECT * FROM holdings WHERE project = $1 AND article = $2 LIMIT 1`,
        [project, article]
      );
      return rowToHolding(rows[0]);
    },
    async getHolding(id) {
      const { rows } = await q(`SELECT * FROM holdings WHERE id = $1`, [id]);
      return rowToHolding(rows[0]);
    },
    async createHolding(h) {
      await q(
        `INSERT INTO holdings
           (id, user_id, project, article, display_title, lang, key,
            purchase_price, purchased_date, last_settled_date, total_earned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          h.id, h.userId, h.project, h.article, h.displayTitle, h.lang, h.key,
          h.purchasePrice, h.purchasedDate, h.lastSettledDate, h.totalEarned || 0,
        ]
      );
      return h;
    },
    async applySettlement(id, expectedLast, newLast, earnedDelta) {
      const { rowCount } = await q(
        `UPDATE holdings
           SET last_settled_date = $3, total_earned = total_earned + $4
         WHERE id = $1 AND last_settled_date = $2`,
        [id, expectedLast, newLast, earnedDelta]
      );
      return rowCount > 0;
    },
    async deleteHolding(id) {
      await q(`DELETE FROM holdings WHERE id = $1`, [id]);
    },

    // --- page price cache ---
    async getPageCache(key) {
      const { rows } = await q(`SELECT * FROM page_cache WHERE key = $1`, [key]);
      return rowToCache(rows[0]);
    },
    async setPageCache(entry) {
      await q(
        `INSERT INTO page_cache
           (key, project, article, avg_views, latest_views, change_pct, spark, window_days, updated_at, premium, pending_latest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (key) DO UPDATE SET
           avg_views = EXCLUDED.avg_views,
           latest_views = EXCLUDED.latest_views,
           change_pct = EXCLUDED.change_pct,
           spark = EXCLUDED.spark,
           window_days = EXCLUDED.window_days,
           updated_at = EXCLUDED.updated_at,
           premium = EXCLUDED.premium,
           pending_latest = EXCLUDED.pending_latest`,
        [
          entry.key, entry.project, entry.article, entry.avgViews,
          entry.latestViews ?? null, entry.changePct ?? null,
          entry.spark ? JSON.stringify(entry.spark) : null,
          entry.windowDays, entry.updatedAt, entry.premium ?? null,
          entry.pendingLatest ?? false,
        ]
      );
      return entry;
    },

    // --- watchlist ---
    async watchlistForUser(userId) {
      const { rows } = await q(
        `SELECT * FROM watchlist WHERE user_id = $1 ORDER BY added_at DESC`,
        [userId]
      );
      return rows.map((r) => ({
        userId: r.user_id,
        project: r.project,
        article: r.article,
        displayTitle: r.display_title,
        addedAt: r.added_at,
      }));
    },
    async isWatched(userId, project, article) {
      const { rows } = await q(
        `SELECT 1 FROM watchlist WHERE user_id = $1 AND project = $2 AND article = $3`,
        [userId, project, article]
      );
      return rows.length > 0;
    },
    async addWatch(entry) {
      await q(
        `INSERT INTO watchlist (user_id, project, article, display_title, added_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [entry.userId, entry.project, entry.article, entry.displayTitle, entry.addedAt]
      );
    },
    async removeWatch(userId, project, article) {
      await q(
        `DELETE FROM watchlist WHERE user_id = $1 AND project = $2 AND article = $3`,
        [userId, project, article]
      );
    },

    // --- activity feed ---
    async logActivity(event) {
      await q(
        `INSERT INTO activity (id, ts, type, username, article, display_title, amount, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [event.id, event.ts, event.type, event.username, event.article ?? null,
         event.displayTitle ?? null, event.amount ?? null, event.userId ?? null]
      );
    },
    async recentActivity(limit) {
      const { rows } = await q(
        `SELECT * FROM activity ORDER BY ts DESC LIMIT $1`,
        [limit]
      );
      return rows.map(rowToActivity);
    },
    async activityForUser(userId, limit) {
      const { rows } = await q(
        `SELECT * FROM activity WHERE user_id = $1 ORDER BY ts DESC LIMIT $2`,
        [userId, limit]
      );
      return rows.map(rowToActivity);
    },

    // --- bets (24h directional price predictions) ---
    async createBet(bet) {
      await q(
        `INSERT INTO bets
           (id, user_id, project, article, display_title, direction, stake,
            start_price, placed_at, resolves_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
        [
          bet.id, bet.userId, bet.project, bet.article, bet.displayTitle,
          bet.direction, bet.stake, bet.startViews, bet.placedAt, bet.resolvesAt,
        ]
      );
      return bet;
    },
    async betsForUser(userId, status) {
      const { rows } = status
        ? await q(
            `SELECT * FROM bets WHERE user_id = $1 AND status = $2 ORDER BY placed_at DESC`,
            [userId, status]
          )
        : await q(`SELECT * FROM bets WHERE user_id = $1 ORDER BY placed_at DESC`, [userId]);
      return rows.map(rowToBet);
    },
    // Compare-and-set via the WHERE status='open' guard - only one concurrent
    // resolve can win. Returns true if this call applied the resolution.
    async resolveBet(id, updates) {
      const { rowCount } = await q(
        `UPDATE bets
           SET status = 'resolved', end_price = $2, payout = $3, resolved_at = $4
         WHERE id = $1 AND status = 'open'`,
        [id, updates.endViews, updates.payout, updates.resolvedAt]
      );
      return rowCount > 0;
    },

    // --- listings (secondary market) ---
    // A listing's id is its holding's id, so (re-)listing is a natural upsert.
    async createListing(listing) {
      await q(
        `INSERT INTO listings
           (id, seller_id, project, article, display_title, lang, ask_price, listed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           ask_price = EXCLUDED.ask_price,
           listed_at = EXCLUDED.listed_at`,
        [
          listing.id, listing.sellerId, listing.project, listing.article,
          listing.displayTitle, listing.lang, listing.askPrice, listing.listedAt,
        ]
      );
      return listing;
    },
    async getListing(id) {
      const { rows } = await q(`SELECT * FROM listings WHERE id = $1`, [id]);
      return rowToListing(rows[0]);
    },
    async allActiveListings() {
      const { rows } = await q(`SELECT * FROM listings ORDER BY listed_at DESC`);
      return rows.map(rowToListing);
    },
    // Atomic delete-and-return - used for both buying and cancelling, so a
    // concurrent double-buy (or buy-vs-cancel race) can only succeed once.
    async claimListing(id) {
      const { rows } = await q(`DELETE FROM listings WHERE id = $1 RETURNING *`, [id]);
      return rowToListing(rows[0]);
    },
  };
}
