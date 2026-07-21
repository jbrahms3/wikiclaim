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
        email: r.email,
        credits: r.credits,
        createdAt: r.created_at,
        needsUsername: r.needs_username,
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
        latestEarned: r.latest_earned,
        earningsRepaired: r.earnings_repaired,
        escrowedEarned: r.escrowed_earned,
        escrowStreakDays: r.escrow_streak_days,
        escrowFlagged: r.escrow_flagged,
        escrowFlagReason: r.escrow_flag_reason,
        escrowFlaggedAt: r.escrow_flagged_at,
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
// hold view counts, not prices. `direction` is legacy (pre exact-guess
// mechanic) - still read so old open bets resolve correctly, never written
// by new bets (see guess/baseline_avg/band/graded_views).
const rowToBet = (r) =>
  r
    ? {
        id: r.id,
        userId: r.user_id,
        project: r.project,
        article: r.article,
        displayTitle: r.display_title,
        direction: r.direction,
        guess: r.guess,
        baselineAvg: r.baseline_avg,
        band: r.band,
        stake: r.stake,
        startViews: r.start_price,
        placedAt: r.placed_at,
        resolvesAt: r.resolves_at,
        status: r.status,
        endViews: r.end_price,
        gradedViews: r.graded_views,
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

const rowToNotification = (r) =>
  r
    ? {
        id: r.id,
        userId: r.user_id,
        type: r.type,
        amount: r.amount,
        article: r.article,
        displayTitle: r.display_title,
        data: r.data || null,
        read: r.read,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
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
      // Newly-provisioned accounts must pick their own username instead of
      // keeping the auto-generated one - defaults to false so existing rows
      // aren't retroactively forced through the prompt.
      await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_username BOOLEAN NOT NULL DEFAULT false;`);
      // Pulled from Clerk's profile at first-sign-in for welcome/marketing
      // emails (see email.js); Clerk still owns identity, this is just a copy.
      await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`);
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
      // latest_earned is the most recent successfully settled day's payout;
      // it keeps live readership estimates separate from credited points.
      // Existing rows default to repair=false so the narrow legacy recovery
      // in game.js can restore holdings skipped by the old empty-response bug.
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS latest_earned BIGINT NOT NULL DEFAULT 0;`);
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS earnings_repaired BOOLEAN NOT NULL DEFAULT false;`);
      // Anti-botting earnings cap (see contiguousSettlement in game.js):
      // escrowed_earned accumulates daily view counts credited above the
      // rolling-baseline cap; escrow_flagged marks a holding as needing
      // manual review (/api/admin/escrow) once the held amount or the
      // consecutive over-cap streak crosses a threshold. Never auto-released.
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS escrowed_earned BIGINT NOT NULL DEFAULT 0;`);
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS escrow_streak_days INTEGER NOT NULL DEFAULT 0;`);
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS escrow_flagged BOOLEAN NOT NULL DEFAULT false;`);
      // Recorded once, at the moment a holding is first flagged (see
      // settleHolding in game.js) - never overwritten while still flagged,
      // so it reflects the actual trigger even though escrowed_earned/
      // escrow_streak_days keep changing afterward.
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS escrow_flag_reason TEXT;`);
      await q(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS escrow_flagged_at BIGINT;`);
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
      // Exact-guess prediction mechanic replaced the plain up/down direction
      // bet - direction is kept (nullable now) only so pre-existing open
      // bets still resolve under the old rules (see resolveBetIfDue in
      // game.js); every new bet sets guess/baseline_avg/band instead.
      await q(`ALTER TABLE bets ALTER COLUMN direction DROP NOT NULL;`);
      await q(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS guess BIGINT;`);
      await q(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS baseline_avg DOUBLE PRECISION;`);
      await q(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS band DOUBLE PRECISION;`);
      await q(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS graded_views BIGINT;`);
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
      // Exclusive ownership needs "does anyone own this article" lookups,
      // and - the actual enforcement - a real uniqueness guarantee so two
      // concurrent buys of the same unowned article can't both succeed
      // (application-level check-then-act isn't atomic; this is). Best
      // effort: an existing deploy with legacy duplicate ownership (from
      // before exclusivity existed) would fail to create this index, so we
      // don't let that crash startup - it just means that specific deploy
      // stays unprotected against the race until its old duplicates are
      // cleaned up, same as before this fix.
      await q(`CREATE INDEX IF NOT EXISTS holdings_article_idx ON holdings (project, article);`);
      try {
        await q(
          `CREATE UNIQUE INDEX IF NOT EXISTS holdings_article_unique_idx ON holdings (project, article);`
        );
      } catch (err) {
        console.warn(
          "Could not create holdings_article_unique_idx (likely pre-existing duplicate ownership rows) - the buy-race guard falls back to application-level checks only:",
          err.message
        );
      }

      // Notification center: private, per-user alerts (today's earnings,
      // escrow decisions, ...) distinct from the public activity feed.
      // dedup_key lets a repeatable event (e.g. "today's earnings") upsert
      // into a single running notification instead of spamming a new row
      // per settlement pass - see addOrIncrementNotification. Only
      // non-null dedup_keys are constrained so one-off notifications
      // (escrow decisions) never collide with each other.
      await q(`
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          amount BIGINT,
          article TEXT,
          display_title TEXT,
          data JSONB,
          dedup_key TEXT,
          read BOOLEAN NOT NULL DEFAULT false,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
      await q(
        `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_idx ON notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;`
      );
      await q(
        `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);`
      );
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
        `INSERT INTO users (id, username, clerk_user_id, email, credits, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, user.username, user.clerkUserId, user.email || null, user.credits, user.createdAt]
      );
      return user;
    },
    // Atomic JIT-provisioning guard: concurrent first-sign-in requests for the
    // same Clerk user race to create the internal record. ON CONFLICT on
    // clerk_user_id means only one insert wins; the rest get the winner back
    // instead of hitting a duplicate-username error.
    async createUserIfNotExists(user) {
      try {
        const { rows } = await q(
          `INSERT INTO users (id, username, clerk_user_id, email, credits, created_at, needs_username)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (clerk_user_id) WHERE clerk_user_id IS NOT NULL DO NOTHING
           RETURNING *`,
          [user.id, user.username, user.clerkUserId, user.email || null, user.credits, user.createdAt, !!user.needsUsername]
        );
        if (rows[0]) return { user: rowToUser(rows[0]), created: true };
        const existing = await this.findUserByClerkId(user.clerkUserId);
        return { user: existing, created: false };
      } catch (err) {
        if (err.code !== "23505") throw err;
        // Not the clerk_user_id race - a different user already has this
        // exact generated username. Disambiguate and retry once.
        const existing = await this.findUserByClerkId(user.clerkUserId);
        if (existing) return { user: existing, created: false };
        const { rows } = await q(
          `INSERT INTO users (id, username, clerk_user_id, email, credits, created_at, needs_username)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [user.id, `${user.username}_${user.id.slice(-4)}`, user.clerkUserId, user.email || null, user.credits, user.createdAt, !!user.needsUsername]
        );
        return { user: rowToUser(rows[0]), created: true };
      }
    },
    // Called from the mandatory post-signup username prompt. The
    // case-insensitive unique index enforces no-collision; a 23505 here means
    // someone else already has that exact name.
    async setUsername(userId, username) {
      try {
        const { rows } = await q(
          `UPDATE users SET username = $1, needs_username = false WHERE id = $2 RETURNING *`,
          [username, userId]
        );
        return rowToUser(rows[0]);
      } catch (err) {
        if (err.code === "23505") return null;
        throw err;
      }
    },
    // Backfills email for accounts provisioned before this column existed
    // (see scripts/backfill-emails.js) - Clerk remains the source of truth.
    async setEmail(userId, email) {
      await q(`UPDATE users SET email = $2 WHERE id = $1`, [userId, email]);
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
            purchase_price, purchased_date, last_settled_date, total_earned,
            latest_earned, earnings_repaired)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          h.id, h.userId, h.project, h.article, h.displayTitle, h.lang, h.key,
          h.purchasePrice, h.purchasedDate, h.lastSettledDate, h.totalEarned || 0,
          h.latestEarned || 0, !!h.earningsRepaired,
        ]
      );
      return h;
    },
    // Relies on holdings_article_unique_idx: the INSERT itself is the atomic
    // check, unlike a separate SELECT-then-INSERT which two concurrent
    // callers could both pass. Returns null (instead of throwing) on a
    // uniqueness conflict, so the caller can treat "someone beat me to it"
    // as an ordinary outcome rather than an unexpected error.
    async createHoldingIfUnowned(h) {
      try {
        await q(
          `INSERT INTO holdings
             (id, user_id, project, article, display_title, lang, key,
              purchase_price, purchased_date, last_settled_date, total_earned,
              latest_earned, earnings_repaired)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            h.id, h.userId, h.project, h.article, h.displayTitle, h.lang, h.key,
            h.purchasePrice, h.purchasedDate, h.lastSettledDate, h.totalEarned || 0,
            h.latestEarned || 0, !!h.earningsRepaired,
          ]
        );
        return h;
      } catch (err) {
        if (err.code === "23505") return null; // unique_violation
        throw err;
      }
    },
    async applySettlement(
      id, expectedLast, newLast, earnedDelta, latestEarned,
      escrowDelta = 0, escrowStreakDays = 0, escrowFlagged = false,
      escrowFlagReason = null, escrowFlaggedAt = null
    ) {
      // COALESCE(existing, new): reason/flaggedAt are only ever passed
      // non-null on the actual first-flag transition (see settleHolding),
      // so this sets them once and never overwrites afterward.
      const { rowCount } = await q(
        `UPDATE holdings
           SET last_settled_date = $3,
               total_earned = total_earned + $4,
               latest_earned = $5,
               escrowed_earned = escrowed_earned + $6,
               escrow_streak_days = $7,
               escrow_flagged = escrow_flagged OR $8,
               escrow_flag_reason = COALESCE(escrow_flag_reason, $9),
               escrow_flagged_at = COALESCE(escrow_flagged_at, $10)
         WHERE id = $1 AND last_settled_date = $2`,
        [id, expectedLast, newLast, earnedDelta, latestEarned, escrowDelta, escrowStreakDays, escrowFlagged, escrowFlagReason, escrowFlaggedAt]
      );
      return rowCount > 0;
    },
    async applyEarningsRepair(id, expectedLast, earnedDelta, latestEarned) {
      const { rowCount } = await q(
        `UPDATE holdings
           SET total_earned = total_earned + $3,
               latest_earned = $4,
               earnings_repaired = true
         WHERE id = $1
           AND last_settled_date = $2
           AND total_earned = 0
           AND earnings_repaired = false`,
        [id, expectedLast, earnedDelta, latestEarned]
      );
      return rowCount > 0;
    },
    async deleteHolding(id) {
      await q(`DELETE FROM holdings WHERE id = $1`, [id]);
    },
    // --- anti-botting escrow review (see game.js's contiguousSettlement) ---
    async listFlaggedHoldings() {
      const { rows } = await q(
        `SELECT * FROM holdings WHERE escrow_flagged = true ORDER BY escrowed_earned DESC`
      );
      return rows.map(rowToHolding);
    },
    // Manual admin decision on a flagged holding's held-back earnings: credit
    // them to the owner (release) or discard them (forfeit). Either way the
    // holding's escrow state resets so settlement can accumulate fresh
    // evidence rather than staying permanently flagged. Not wrapped in a
    // transaction - this is a rare, manual, single-operator action, not a
    // contended hot path, so the small window between the two updates isn't
    // worth the added complexity.
    async resolveEscrow(id, credit) {
      const { rows } = await q(`SELECT * FROM holdings WHERE id = $1`, [id]);
      const h = rowToHolding(rows[0]);
      if (!h || !h.escrowFlagged) return null;
      const amount = h.escrowedEarned;
      await q(
        `UPDATE holdings
           SET escrowed_earned = 0, escrow_streak_days = 0, escrow_flagged = false,
               escrow_flag_reason = NULL, escrow_flagged_at = NULL,
               total_earned = total_earned + $2
         WHERE id = $1`,
        [id, credit ? amount : 0]
      );
      if (credit && amount > 0) {
        await q(`UPDATE users SET credits = credits + $2 WHERE id = $1`, [h.userId, amount]);
      }
      return { holdingId: id, userId: h.userId, article: h.article, displayTitle: h.displayTitle, amount, credited: !!credit };
    },

    // --- notification center ---
    // Insert-or-increment: when n.dedupKey matches an existing notification
    // for this user, the new amount is ADDED to it (rather than replacing)
    // and it's marked unread again - used for "today's earnings", which
    // accumulates across possibly-several settlement passes in a day rather
    // than firing once. A null dedupKey (one-off events like an escrow
    // decision) always inserts a fresh row instead.
    async addOrIncrementNotification(n) {
      const { rows } = await q(
        `INSERT INTO notifications
           (id, user_id, type, amount, article, display_title, data, dedup_key, read, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$9)
         ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL
         DO UPDATE SET
           amount = notifications.amount + EXCLUDED.amount,
           read = false,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          n.id, n.userId, n.type, n.amount ?? null, n.article ?? null, n.displayTitle ?? null,
          n.data ? JSON.stringify(n.data) : null, n.dedupKey ?? null, n.ts,
        ]
      );
      return rowToNotification(rows[0]);
    },
    async notificationsForUser(userId, limit = 30) {
      const { rows } = await q(
        `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
      );
      return rows.map(rowToNotification);
    },
    async unreadNotificationCount(userId) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read = false`,
        [userId]
      );
      return rows[0] ? rows[0].c : 0;
    },
    async markNotificationRead(id, userId) {
      const { rowCount } = await q(
        `UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return rowCount > 0;
    },
    async markAllNotificationsRead(userId) {
      await q(`UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`, [userId]);
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

    // --- bets (24h exact-guess view-count predictions) ---
    async createBet(bet) {
      await q(
        `INSERT INTO bets
           (id, user_id, project, article, display_title, guess, baseline_avg, band, stake,
            start_price, placed_at, resolves_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open')`,
        [
          bet.id, bet.userId, bet.project, bet.article, bet.displayTitle,
          bet.guess, bet.baselineAvg, bet.band, bet.stake, bet.startViews, bet.placedAt, bet.resolvesAt,
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
           SET status = 'resolved', end_price = $2, graded_views = $3, payout = $4, resolved_at = $5
         WHERE id = $1 AND status = 'open'`,
        [id, updates.endViews, updates.gradedViews ?? null, updates.payout, updates.resolvedAt]
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
