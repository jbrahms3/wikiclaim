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
  fetchDailyPageviews,
  latestAvailableDate,
  addDaysUTC,
  parseDate,
} from "./wikimedia.js";

const STARTING_CREDITS = 250;

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

  holding.lastSettledDate = fmtDate(latest);
  holding.totalEarned = (holding.totalEarned || 0) + earned;
  store.saveHolding(holding);

  if (earned > 0) {
    const owner = store.getUser(holding.userId);
    owner.credits += earned;
    store.saveUser(owner);
  }
  return earned;
}

/** Settle every holding for a user. Returns total credits earned this pass. */
export async function settleUser(userId) {
  const holdings = store.holdingsForUser(userId);
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
  const user = store.getUser(userId);
  const holdings = store.holdingsForUser(userId);

  const items = [];
  let holdingsValue = 0;
  for (const h of holdings) {
    const price = await getPagePrice(h.project, h.article);
    holdingsValue += price.avgViews;
    items.push({
      id: h.id,
      article: h.article,
      displayTitle: h.displayTitle,
      lang: h.lang,
      project: h.project,
      url: `https://${h.lang}.wikipedia.org/wiki/${h.article}`,
      purchasePrice: h.purchasePrice,
      currentPrice: price.avgViews,
      totalEarned: h.totalEarned || 0,
      purchasedDate: h.purchasedDate,
    });
  }
  items.sort((a, b) => b.currentPrice - a.currentPrice);

  return {
    user: publicUser(user),
    holdings: items,
    holdingsValue,
    netWorth: user.credits + holdingsValue,
  };
}

export function publicUser(u) {
  return { id: u.id, username: u.username, credits: u.credits };
}

/** Buy a page. Throws Error with a user-facing message on failure. */
export async function buyPage(userId, { project, article, displayTitle, lang }) {
  const user = store.getUser(userId);
  if (store.findHolding(userId, project, article)) {
    throw new Error("You already own this page.");
  }
  const price = await getPagePrice(project, article, { force: true });
  const cost = price.avgViews;
  if (user.credits < cost) {
    throw new Error(
      `Not enough credits: costs ${cost}, you have ${user.credits}.`
    );
  }

  user.credits -= cost;
  store.saveUser(user);

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
  store.saveHolding(holding);
  return { holding, cost, creditsLeft: user.credits };
}

/** Sell a page back to the market at its current price. */
export async function sellPage(userId, holdingId) {
  const holding = store.getHolding(holdingId);
  if (!holding || holding.userId !== userId) {
    throw new Error("You don't own that page.");
  }
  const price = await getPagePrice(holding.project, holding.article);
  const proceeds = price.avgViews;

  const user = store.getUser(userId);
  user.credits += proceeds;
  store.saveUser(user);
  store.deleteHolding(holdingId);

  return { proceeds, creditsLeft: user.credits };
}

/** Leaderboard by net worth (credits + current value of all holdings). */
export async function leaderboard() {
  const users = store.allUsers();
  const rows = [];
  for (const u of users) {
    const holdings = store.holdingsForUser(u.id);
    let value = 0;
    for (const h of holdings) {
      const price = await getPagePrice(h.project, h.article);
      value += price.avgViews;
    }
    rows.push({
      username: u.username,
      credits: u.credits,
      pages: holdings.length,
      netWorth: u.credits + value,
    });
  }
  rows.sort((a, b) => b.netWorth - a.netWorth);
  return rows;
}
