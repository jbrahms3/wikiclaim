// Core game rules: buying, selling, and settling daily earnings.
//
// Settlement is lazy: instead of a background cron, every time a user's
// portfolio is read we credit each holding for all days that have become
// available since it was last settled. This means a page owned for N days
// earns exactly N days of real pageviews, no more, no less, and it works even
// if the server was offline.
import { store, uid } from "./store.js";
import {
  getPagePrice,
  getArticleHistory,
  fetchDailyPageviews,
  latestAvailableDate,
  addDaysUTC,
  parseDate,
  formatYYYYMMDD,
} from "./wikimedia.js";

// Price = yearly daily-view average + a recency premium (last 30 days'
// total views), see wikimedia.js. 5,000 comfortably covers obscure/niche
// articles while leaving real progression required for popular ones.
const STARTING_CREDITS = 5000;

// Milestone for the Points page's progress bar - reaching this balance earns
// a real $100 gift card (fulfilled manually, outside the app).
export const POINTS_GOAL = 1_000_000;

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function startingCredits() {
  return STARTING_CREDITS;
}

/**
 * Credit a single holding for every not-yet-settled day up to the latest
 * available pageview date. Mutates and saves the holding + owner's credits.
 * Returns the number of credits earned in this settlement pass.
 */
export async function settleHolding(holding) {
  const latest = latestAvailableDate();
  // First earning day is the day AFTER purchase (you "paid" the purchase-day price).
  const start = addDaysUTC(parseDate(holding.lastSettledDate), 1);
  if (start > latest) return 0;

  const views = await fetchDailyPageviews(
    holding.project,
    holding.article,
    start,
    latest
  );

  let earned = 0;
  let cursor = start;
  while (cursor <= latest) {
    earned += views.get(fmtDate(cursor)) || 0;
    cursor = addDaysUTC(cursor, 1);
  }

  const newDate = fmtDate(latest);
  // Compare-and-set on the old settle date: if a concurrent request already
  // settled this window, applied === false and we must not credit again.
  const applied = await store.applySettlement(
    holding.id,
    holding.lastSettledDate,
    newDate,
    earned
  );
  if (!applied) return 0;

  if (earned > 0) {
    await store.addCredits(holding.userId, earned);
    await logEvent(holding.userId, "earn", {
      article: holding.article,
      displayTitle: holding.displayTitle,
      amount: earned,
    });
  }
  return earned;
}

/** Settle every holding for a user. Returns total credits earned this pass. */
export async function settleUser(userId) {
  const holdings = await store.holdingsForUser(userId);
  let total = 0;
  for (const h of holdings) {
    try {
      total += await settleHolding(h);
    } catch (err) {
      console.error("settle failed for", h.key, err);
    }
  }
  return total;
}

/**
 * Build the portfolio view: each holding with its live current price, plus
 * account totals (credits, net worth). Prices are fetched (cached) live.
 */
export async function portfolio(userId) {
  await settleUser(userId);
  await settleBets(userId);
  const user = await store.getUser(userId);
  const holdings = await store.holdingsForUser(userId);
  // A listing's id is its holding's id, so this naturally only matches
  // holdings this user owns - no need to filter by seller separately.
  const listingById = new Map((await store.allActiveListings()).map((l) => [l.id, l]));

  const items = [];
  let holdingsValue = 0;
  let todayEarnings = 0;
  let totalEarned = 0;
  const latestSettledDate = fmtDate(latestAvailableDate());
  for (const h of holdings) {
    // If pricing is temporarily unavailable, show the last verified price
    // (what they paid) instead of a bogus 1 - it self-corrects within minutes.
    let price = null;
    try {
      const p = await getPagePrice(h.project, h.article);
      if (!p.unpriced) price = p;
    } catch {
      /* treat as unpriced */
    }
    const current = price ? price.annualPrice : h.purchasePrice;
    holdingsValue += current;
    // `latestViews` is a live readership figure, not necessarily money the
    // owner has earned. A holding begins earning the day after it is bought,
    // so including the purchase day's views here made this number disagree
    // with both the holding's earned total and the user's credited balance.
    // Only include the latest published day once the owner was eligible to
    // earn for it and its settlement completed. The latter guard also keeps
    // a temporary Wikimedia failure from being presented as earned money.
    const earnedLatestDay =
      h.purchasedDate < latestSettledDate &&
      h.lastSettledDate >= latestSettledDate;
    todayEarnings += earnedLatestDay && price ? price.latestViews ?? price.avgViews : 0;
    totalEarned += h.totalEarned || 0;
    items.push({
      id: h.id,
      article: h.article,
      displayTitle: h.displayTitle,
      lang: h.lang,
      project: h.project,
      url: `https://${h.lang}.wikipedia.org/wiki/${h.article}`,
      purchasePrice: h.purchasePrice,
      currentPrice: current,
      changePct: price ? price.changePct : null,
      pendingLatest: price ? !!price.pendingLatest : false,
      latestViews: price ? price.latestViews : null,
      spark: price ? price.spark || null : null,
      unpriced: !price,
      totalEarned: h.totalEarned || 0,
      purchasedDate: h.purchasedDate,
      listing: listingById.has(h.id) ? { askPrice: listingById.get(h.id).askPrice } : null,
    });
  }
  items.sort((a, b) => b.currentPrice - a.currentPrice);

  return {
    user: publicUser(user),
    holdings: items,
    holdingsValue,
    todayEarnings,
    totalEarned,
    netWorth: user.credits + holdingsValue,
  };
}

/**
 * Combined daily earnings across all holdings for the last `days` days —
 * the dashboard's big chart. Sums each owned page's real daily view series.
 */
export async function portfolioHistory(userId, days) {
  const holdings = await store.holdingsForUser(userId);
  const totals = new Map(); // date -> views
  await Promise.all(
    holdings.map(async (h) => {
      try {
        const series = await getArticleHistory(h.project, h.article, days);
        for (const { date, views } of series) {
          totals.set(date, (totals.get(date) || 0) + views);
        }
      } catch {
        /* one page failing shouldn't blank the chart */
      }
    })
  );
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, views]) => ({ date, views }));
}

export function publicUser(u) {
  return { id: u.id, username: u.username, credits: u.credits, needsUsername: !!u.needsUsername };
}

/** Buy a page. Throws Error with a user-facing message on failure. */
export async function buyPage(userId, { project, article, displayTitle, lang }) {
  if (await store.findHolding(userId, project, article)) {
    throw new Error("You already own this page.");
  }
  // Ownership is exclusive: once anyone owns an article, it's off the
  // primary market - the only way to get it is to buy their listing on the
  // secondary market (if they've made one). This early check is just a fast
  // path (skips a Wikimedia fetch + debit for the obvious case) - the real
  // guarantee against two concurrent buyers both winning is
  // createHoldingIfUnowned below, which is atomic.
  const existingOwner = await store.findAnyHolding(project, article);
  if (existingOwner) {
    const listing = await store.getListing(existingOwner.id);
    throw new Error(
      listing
        ? `This article is owned by another player - buy it on the secondary market for ${listing.askPrice} pts instead.`
        : "This article is already owned by another player and isn't listed for sale."
    );
  }
  // Always re-verify against live data at purchase time; if Wikimedia gives
  // us nothing back, refuse to transact rather than sell at a bogus price.
  const price = await getPagePrice(project, article, { force: true });
  if (price.unpriced) {
    throw new Error(
      "Couldn't verify this article's traffic right now (Wikimedia's stats API returned no data). Try again in a few seconds."
    );
  }
  const cost = price.annualPrice;

  // Atomic: debit only if the balance can cover it (no read-then-write race).
  const creditsLeft = await store.tryDebit(userId, cost);
  if (creditsLeft === null) {
    const user = await store.getUser(userId);
    throw new Error(
      `Not enough credits: costs ${cost}, you have ${user ? user.credits : 0}.`
    );
  }

  const today = fmtDate(latestAvailableDate());
  const holding = {
    id: uid(),
    userId,
    project,
    article,
    displayTitle,
    lang,
    key: `${project}::${article}`,
    purchasePrice: cost,
    purchasedDate: today,
    // Settle from the day after the latest available data, so the buyer earns
    // starting with the next day's fresh traffic rather than back-paying.
    lastSettledDate: today,
    totalEarned: 0,
  };
  const created = await store.createHoldingIfUnowned(holding);
  if (!created) {
    // Lost the race to a concurrent buyer between the check above and here -
    // refund immediately rather than leave the debit stranded.
    await store.addCredits(userId, cost);
    throw new Error("This article was just claimed by someone else. Your credits have been refunded.");
  }
  await logEvent(userId, "claim", { article, displayTitle, amount: cost });
  return { holding, cost, creditsLeft };
}

export async function logEvent(userId, type, { article, displayTitle, amount } = {}) {
  try {
    const user = await store.getUser(userId);
    await store.logActivity({
      id: uid(),
      ts: Date.now(),
      type,
      userId,
      username: user ? user.username : "someone",
      article: article ?? null,
      displayTitle: displayTitle ?? null,
      amount: amount ?? null,
    });
  } catch (err) {
    console.error("activity log failed:", err);
  }
}

export async function recentActivity(limit = 30) {
  return store.recentActivity(limit);
}

/**
 * A user's earning events (daily settlement credits + prediction payouts),
 * newest first - the Points page's history list/chart. Only logs events
 * created after this feature shipped; earlier silent settlements (before
 * settleHolding started logging "earn" events) aren't retroactively added.
 */
export async function earningsHistory(userId, limit = 100) {
  const events = await store.activityForUser(userId, 500);
  return events.filter((e) => e.type === "earn" || e.type === "bet-resolved").slice(0, limit);
}

/** Balance + progress-to-goal + earnings history for the Points page. */
export async function pointsSummary(userId) {
  await settleUser(userId);
  await settleBets(userId);
  const user = await store.getUser(userId);
  const history = await earningsHistory(userId);
  return { credits: user.credits, goal: POINTS_GOAL, history };
}

/**
 * Secondary market: since ownership is exclusive (one owner per article at a
 * time, see buyPage), once someone owns an article the only way anyone else
 * gets it is to buy it from them - there's no instant sell-back to the
 * market. An owner can list their holding at any price they choose; a resale
 * is a genuine peer-to-peer transfer - the buyer's payment goes directly to
 * the seller, creating or destroying no points (unlike an instant sell,
 * which would print credits from nowhere). A listing's id is always its
 * holding's id (one listing per holding).
 */
const MIN_ASK_PRICE = 1;

export async function listForSale(userId, holdingId, askPrice) {
  askPrice = Math.round(Number(askPrice));
  if (!Number.isFinite(askPrice) || askPrice < MIN_ASK_PRICE) {
    throw new Error(`Minimum asking price is ${MIN_ASK_PRICE} point.`);
  }
  const holding = await store.getHolding(holdingId);
  if (!holding || holding.userId !== userId) {
    throw new Error("You don't own that page.");
  }
  const listing = {
    id: holding.id,
    sellerId: userId,
    project: holding.project,
    article: holding.article,
    displayTitle: holding.displayTitle,
    lang: holding.lang,
    askPrice,
    listedAt: Date.now(),
  };
  await store.createListing(listing);
  return listing;
}

export async function cancelListing(userId, listingId) {
  const listing = await store.getListing(listingId);
  if (!listing || listing.sellerId !== userId) {
    throw new Error("You don't have an active listing for that.");
  }
  await store.claimListing(listingId);
  return { cancelled: true };
}

/** All active secondary-market listings, each with the current computed
 * market price attached for comparison (buyers pay the ask price, not this). */
export async function browseListings() {
  const listings = await store.allActiveListings();
  return Promise.all(
    listings.map(async (l) => {
      let marketPrice = null;
      try {
        const p = await getPagePrice(l.project, l.article);
        if (!p.unpriced) marketPrice = p.annualPrice;
      } catch {
        /* comparison price unavailable - the listing itself is still valid */
      }
      const seller = await store.getUser(l.sellerId);
      return { ...l, marketPrice, sellerUsername: seller ? seller.username : "someone" };
    })
  );
}

/** Buy a listing. Throws Error with a user-facing message on failure. */
export async function buyListing(userId, listingId) {
  const listing = await store.getListing(listingId);
  if (!listing) throw new Error("This listing is no longer active.");
  if (listing.sellerId === userId) throw new Error("You can't buy your own listing.");
  if (await store.findHolding(userId, listing.project, listing.article)) {
    throw new Error("You already own this article.");
  }

  // Atomic delete-and-return - a concurrent double-buy can only win once.
  const claimed = await store.claimListing(listingId);
  if (!claimed) throw new Error("This listing was just bought by someone else.");

  // The listing's id is the holding's id - confirm it's still the same
  // holding/seller before taking the buyer's money (defensive; shouldn't
  // diverge in practice, but a stale listing pointing nowhere shouldn't
  // charge anyone).
  const holding = await store.getHolding(listingId);
  if (!holding || holding.userId !== claimed.sellerId) {
    throw new Error("This listing is no longer valid. Try again.");
  }

  const creditsLeft = await store.tryDebit(userId, claimed.askPrice);
  if (creditsLeft === null) {
    await store.createListing(claimed); // put it back - the buyer couldn't actually pay
    const user = await store.getUser(userId);
    throw new Error(
      `Not enough credits: costs ${claimed.askPrice}, you have ${user ? user.credits : 0}.`
    );
  }

  // Transfer ownership: delete the seller's holding, create a fresh one for
  // the buyer - a new owner starts earning fresh, same as any purchase.
  await store.deleteHolding(holding.id);
  const today = fmtDate(latestAvailableDate());
  const newHolding = {
    id: uid(),
    userId,
    project: holding.project,
    article: holding.article,
    displayTitle: holding.displayTitle,
    lang: holding.lang,
    key: holding.key,
    purchasePrice: claimed.askPrice,
    purchasedDate: today,
    lastSettledDate: today,
    totalEarned: 0,
  };
  const created = await store.createHoldingIfUnowned(newHolding);
  if (!created) {
    // A vanishingly rare edge case: a third party's own primary-market
    // purchase raced into the instant between deleteHolding and here and
    // won. The buyer already paid nothing beyond what's about to be
    // refunded (the seller hasn't been paid yet either, since that happens
    // after this point) - refund the buyer rather than leave them charged
    // for nothing.
    await store.addCredits(userId, claimed.askPrice);
    console.error(`buyListing: lost the holding race for ${holding.key} after claiming listing ${listingId} - refunded buyer ${userId}`);
    throw new Error("This article was just claimed by someone else. Your credits have been refunded.");
  }

  // Peer-to-peer: pay the seller directly, not "the market".
  await store.addCredits(claimed.sellerId, claimed.askPrice);
  await logEvent(userId, "resale", {
    article: holding.article,
    displayTitle: holding.displayTitle,
    amount: claimed.askPrice,
  });

  return { holding: newHolding, price: claimed.askPrice, creditsLeft };
}

/** Leaderboard by net worth (credits + current value of all holdings). */
export async function leaderboard() {
  const users = await store.allUsers();
  const rows = [];
  for (const u of users) {
    const holdings = await store.holdingsForUser(u.id);
    let value = 0;
    for (const h of holdings) {
      try {
        const price = await getPagePrice(h.project, h.article);
        value += price.unpriced ? h.purchasePrice : price.annualPrice;
      } catch {
        value += h.purchasePrice; // last verified price
      }
    }
    rows.push({
      id: u.id,
      username: u.username,
      credits: u.credits,
      pages: holdings.length,
      netWorth: u.credits + value,
    });
  }
  rows.sort((a, b) => b.netWorth - a.netWorth);
  return rows;
}

/**
 * Predictions: a 24h directional bet on an article's daily view count (the
 * same number shown elsewhere as "Views (24h)") rather than its price.
 * Price has built-in upward drift for weeks after any spike (it's baked from
 * a rolling 30-day view total, see wikimedia.js), which made "will the price
 * go up" a near-free bet on anything already trending. Raw daily views don't
 * have that inertia - they're genuinely volatile day to day, so calling the
 * direction takes an actual read on the article. Stake is escrowed (debited)
 * immediately; payout is settled lazily, the same pattern as holdings - no
 * cron, resolved whenever the bettor is next active, past-due bets are just
 * caught up on read.
 */
const BET_DURATION_MS = 24 * 60 * 60 * 1000;
const MIN_STAKE = 1;

export async function placeBet(userId, { project, article, displayTitle, direction, stake }) {
  stake = Math.round(Number(stake));
  if (!Number.isFinite(stake) || stake < MIN_STAKE) {
    throw new Error(`Minimum prediction stake is ${MIN_STAKE} point.`);
  }
  if (direction !== "up" && direction !== "down") {
    throw new Error("Direction must be 'up' or 'down'.");
  }

  // Force a live check, same as buying - refuse rather than lock in a bet
  // against a stale or bogus starting view count.
  const price = await getPagePrice(project, article, { force: true });
  if (price.unpriced) {
    throw new Error(
      "Couldn't verify this article's views right now (Wikimedia's stats API returned no data). Try again in a few seconds."
    );
  }
  // pendingLatest means Wikimedia hasn't published this article's most
  // recent day yet, so "latestViews" is a 30-day-average stand-in, not a
  // real day - starting a day-by-day bet from an averaged number would
  // undermine the whole point. Wait for the real figure instead.
  if (price.pendingLatest) {
    throw new Error(
      "Today's view count for this article hasn't been published by Wikimedia yet. Try again in a bit."
    );
  }
  const startViews = Math.max(1, price.latestViews);
  // startViews came from latestAvailableDate() (Wikimedia's ~1-day publish
  // lag means that's always "yesterday", already final by the time we can
  // read it) - the bet is really "will the NEXT day's views be higher or
  // lower", so targetDate is the specific calendar day whose figure settles
  // it, not just "24 hours from now".
  const targetDate = formatYYYYMMDD(addDaysUTC(latestAvailableDate(), 1));

  const creditsLeft = await store.tryDebit(userId, stake);
  if (creditsLeft === null) {
    const user = await store.getUser(userId);
    throw new Error(
      `Not enough credits: stake is ${stake}, you have ${user ? user.credits : 0}.`
    );
  }

  const now = Date.now();
  const bet = {
    id: uid(),
    userId,
    project,
    article,
    displayTitle,
    direction,
    stake,
    startViews,
    targetDate,
    placedAt: now,
    resolvesAt: now + BET_DURATION_MS, // kept as a display estimate - actual resolution can land earlier
    status: "open",
    endViews: null,
    payout: null,
    resolvedAt: null,
  };
  await store.createBet(bet);
  await logEvent(userId, "bet", { article, displayTitle, amount: stake });
  return { bet, creditsLeft };
}

// How much longer past the normal resolution estimate to keep waiting for a
// real published day's figure before giving up and refunding the stake instead.
const RESOLUTION_GRACE_MS = 24 * 60 * 60 * 1000;

// Bets placed before targetDate existed have no way to know which specific
// day they're settling against - fall back to the old assumption (the day
// the bet was placed, UTC), which is what targetDate would have computed
// to anyway (see placeBet).
function targetDateFor(bet) {
  if (bet.targetDate) return bet.targetDate;
  const placed = new Date(bet.placedAt);
  return formatYYYYMMDD(new Date(Date.UTC(placed.getUTCFullYear(), placed.getUTCMonth(), placed.getUTCDate())));
}

/**
 * Resolve one bet as soon as its target day's real view count has actually
 * been published - not on a fixed timer. Wikimedia's publish lag means that
 * day is usually ready well before the 24h display estimate (bet late in the
 * UTC day and it can be ready in minutes), so this checks for the real data
 * every time a settle pass runs rather than waiting out the clock. Payout
 * scales with the real % move in daily views: guess the direction right and
 * get more than your stake back, wrong and get less (floored at 0 - you
 * can't lose more than you staked). A Wikimedia hiccup at resolution time
 * refunds the stake instead of penalizing the player for an API outage.
 */
async function resolveBetIfDue(bet) {
  if (bet.status !== "open") return null;
  const targetDate = targetDateFor(bet);

  // Cheap date-only check first, no API call: the target day can't possibly
  // be published until it's at least become "yesterday" for real.
  if (formatYYYYMMDD(latestAvailableDate()) < targetDate) return null;

  const giveUp = Date.now() >= bet.resolvesAt + RESOLUTION_GRACE_MS;
  let endViews = bet.startViews;
  try {
    const target = parseDate(targetDate);
    const views = await fetchDailyPageviews(bet.project, bet.article, target, target);
    const raw = views.get(targetDate);
    if (raw == null) {
      // The day has rolled over but Wikimedia hasn't actually published it
      // yet - keep waiting for a later settle pass unless we've given it a
      // full extra day of grace already.
      if (!giveUp) return null;
      // Past the grace period: unknowable, so refund rather than guess -
      // endViews stays at startViews (break-even), same as an API hiccup.
    } else {
      endViews = Math.max(1, raw);
    }
  } catch {
    if (!giveUp) return null;
    /* endViews stays at startViews -> break-even refund */
  }

  const pctChange = (endViews - bet.startViews) / bet.startViews;
  const signedPct = bet.direction === "up" ? pctChange : -pctChange;
  const payout = Math.max(0, Math.round(bet.stake * (1 + signedPct)));

  const applied = await store.resolveBet(bet.id, {
    endViews,
    payout,
    resolvedAt: Date.now(),
  });
  if (!applied) return null; // a concurrent settle pass already resolved this one

  if (payout > 0) await store.addCredits(bet.userId, payout);
  await logEvent(bet.userId, "bet-resolved", {
    article: bet.article,
    displayTitle: bet.displayTitle,
    amount: payout,
  });
  return payout;
}

/** Resolve every past-due open bet for a user. Call before reading bets/credits. */
export async function settleBets(userId) {
  const open = await store.betsForUser(userId, "open");
  for (const b of open) {
    try {
      await resolveBetIfDue(b);
    } catch (err) {
      console.error("bet resolution failed for", b.id, err);
    }
  }
}

/** Open bets (with a live current view count for an in-progress win/loss read) + recent history. */
export async function listBets(userId) {
  await settleBets(userId);
  const [openRaw, resolvedRaw] = await Promise.all([
    store.betsForUser(userId, "open"),
    store.betsForUser(userId, "resolved"),
  ]);

  const open = await Promise.all(
    openRaw.map(async (b) => {
      let currentViews = b.startViews;
      try {
        const p = await getPagePrice(b.project, b.article);
        // Same reasoning as resolution: an averaged pendingLatest number
        // isn't a real day, so it'd be a misleading live preview - just
        // show "no new info yet" (even) until a real figure is published.
        if (!p.unpriced && !p.pendingLatest) currentViews = Math.max(1, p.latestViews);
      } catch {
        /* show start views as a fallback */
      }
      return { ...b, currentViews };
    })
  );

  return { open, resolved: resolvedRaw.slice(0, 30) };
}
