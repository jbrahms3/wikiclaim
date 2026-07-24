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
  getRandomArticles,
  getPageCreationDate,
  MIN_ARTICLE_AGE_DAYS,
} from "./wikimedia.js";
import { checkSpike } from "./spike-check.js";

// Price = yearly daily-view average + a recency premium (last 30 days'
// total views), see wikimedia.js. 5,000 comfortably covers obscure/niche
// articles while leaving real progression required for popular ones.
const STARTING_CREDITS = 5000;

// Milestone for the Points page's progress bar - reaching this balance earns
// a real $25 gift card (fulfilled manually, outside the app).
export const POINTS_GOAL = 1_000_000;

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function startingCredits() {
  return STARTING_CREDITS;
}

/**
 * Anti-botting earnings cap. Wikimedia's pageviews API can't distinguish "a
 * person kept reloading the article" from genuine readership, and settlement
 * used to pay the raw daily view count 1:1 forever - an unbounded exploit
 * for anyone willing to automate a refresh loop. Daily credited earnings are
 * now capped against a short rolling baseline (the last EARNINGS_BASELINE_
 * WINDOW_DAYS days, NOT the pricing engine's year-long average, which would
 * take too long to "forgive" a genuinely new-normal popularity shift), with
 * the tolerance shrinking as the baseline grows: a fixed 50% window is
 * trivial to fake on an obscure page (a handful of refreshes) but represents
 * an enormous number of real viewers on a popular one.
 */
const EARNINGS_BASELINE_WINDOW_DAYS = 30;
const EARNINGS_CAP_FLOOR = 1.15; // large articles: max +15%/day over baseline
const EARNINGS_CAP_CEILING = 1.5; // tiny articles: max +50%/day over baseline
const EARNINGS_CAP_K = 500; // controls how fast the cap shrinks toward the floor

export function earningsCapMultiplier(baseline) {
  return (
    EARNINGS_CAP_FLOOR +
    (EARNINGS_CAP_CEILING - EARNINGS_CAP_FLOOR) / (1 + baseline / EARNINGS_CAP_K)
  );
}

// Anything above the cap isn't forfeited outright - a real viral day
// deserves to eventually be paid - it's held in escrow on the holding
// instead. It's flagged for manual review (see /api/admin/escrow in
// server.js) once it crosses either threshold below: one single huge spike,
// or several smaller-but-sustained over-cap days in a row (a botnet could in
// principle keep running for days, so "it persisted" alone can't be trusted
// as automatic proof of legitimacy - a human has to look). Escrow is never
// auto-released; it sits flagged until an admin approves or forfeits it.
export const ESCROW_FLAG_AMOUNT = 500;
export const ESCROW_FLAG_STREAK_DAYS = 3;

// A one- or two-day "baseline" is just noise, not a reliable read on what's
// normal for an article - capping against that thin a sample would unfairly
// penalize e.g. a holding that's only been settled a couple of times so far.
const MIN_BASELINE_DAYS = 7;

/**
 * Return the contiguous, actually-published portion of a requested settlement
 * window. Wikimedia can temporarily return an empty response or omit its most
 * recent day; a missing date must never be interpreted as a real zero.
 *
 * `views` must also contain up to EARNINGS_BASELINE_WINDOW_DAYS of data
 * before `start` (if available) so each settled day's rolling baseline can
 * be computed - see settleHolding, which fetches that wider window.
 * `incomingStreakDays` carries the over-cap streak across separate
 * settlement passes (settlement usually advances one day at a time), so a
 * botnet can't reset the streak just by running across multiple visits.
 */
export function contiguousSettlement(views, start, latest, incomingStreakDays = 0) {
  let earned = 0;
  let latestEarned = 0;
  let settledThrough = null;
  let escrowDelta = 0;
  let streakDays = incomingStreakDays;
  let cursor = start;
  while (cursor <= latest) {
    const date = fmtDate(cursor);
    if (!views.has(date)) break;
    const raw = views.get(date);

    // Rolling baseline: the average of however many of the preceding
    // EARNINGS_BASELINE_WINDOW_DAYS days we actually have data for (skips
    // gaps rather than treating a missing day as 0 traffic). With too little
    // prior data (a brand-new article, or a holding only settled once or
    // twice so far), there's nothing reliable to judge "normal" against, so
    // the cap doesn't apply that day.
    let baselineSum = 0;
    let baselineDays = 0;
    for (let i = 1; i <= EARNINGS_BASELINE_WINDOW_DAYS; i++) {
      const bDate = fmtDate(addDaysUTC(cursor, -i));
      if (views.has(bDate)) {
        baselineSum += views.get(bDate);
        baselineDays++;
      }
    }
    const baseline = baselineDays >= MIN_BASELINE_DAYS ? Math.max(1, baselineSum / baselineDays) : raw;
    const cap = Math.round(baseline * earningsCapMultiplier(baseline));
    const credited = Math.min(raw, cap);
    const excess = Math.max(0, raw - credited);

    earned += credited;
    latestEarned = credited;
    escrowDelta += excess;
    streakDays = excess > 0 ? streakDays + 1 : 0;
    settledThrough = date;
    cursor = addDaysUTC(cursor, 1);
  }
  return { earned, latestEarned, settledThrough, escrowDelta, streakDays };
}

// Right after the UTC day rolls over (early evening in the Americas),
// Wikimedia hasn't published that day for anything yet - so no holding can
// settle, and every settleHolding call during that window is guaranteed
// wasted work. It isn't cheap work either: the fetch spans
// EARNINGS_BASELINE_WINDOW_DAYS of lookback plus the settlement window, so it
// comes back 200 (the baseline days ARE published, only the newest is
// missing) and neither the pageviews negative cache (404s only, short ranges
// only) nor the price cache absorbs it. That left one live Wikimedia round
// trip per holding on every single /api/me for the whole multi-hour lag
// window, queued behind the same global limiter as everything else - which is
// what pushed /api/me past the frontend's request timeout and left the page
// sitting on "Checking your session...". Remember the miss per article
// instead and answer "nothing to settle yet" until it's worth another look.
const settlementBlocked = new Map(); // "project::article" -> { date, until }
const SETTLEMENT_RETRY_MS = 10 * 60 * 1000;

function rememberUnsettled(key, date) {
  // Keys are per-article, so this is naturally bounded by the number of
  // distinct owned pages; sweep expired entries anyway if it ever gets big.
  if (settlementBlocked.size > 5000) {
    const now = Date.now();
    for (const [k, v] of settlementBlocked) if (v.until <= now) settlementBlocked.delete(k);
  }
  settlementBlocked.set(key, { date, until: Date.now() + SETTLEMENT_RETRY_MS });
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

  const latestDate = fmtDate(latest);
  const blockKey = `${holding.project}::${holding.article}`;
  const blocked = settlementBlocked.get(blockKey);
  // Scoped to the exact day we're waiting on, so a new UTC day always gets a
  // fresh attempt rather than inheriting the previous day's backoff.
  if (blocked && blocked.date === latestDate && Date.now() < blocked.until) return 0;

  // Fetch extra lookback so contiguousSettlement can compute a real rolling
  // baseline for every day in the settlement window, not just the window
  // itself - see EARNINGS_BASELINE_WINDOW_DAYS.
  const fetchStart = addDaysUTC(start, -EARNINGS_BASELINE_WINDOW_DAYS);
  const views = await fetchDailyPageviews(
    holding.project,
    holding.article,
    fetchStart,
    latest
  );

  const { earned, latestEarned, settledThrough, escrowDelta, streakDays } = contiguousSettlement(
    views,
    start,
    latest,
    holding.escrowStreakDays || 0
  );
  // Anything short of the latest day means it isn't published for this
  // article yet (publish lag isn't uniform across articles). Back off before
  // returning - including on the partial-settle path, where the days we DID
  // get still have to be credited below.
  if (settledThrough !== latestDate) rememberUnsettled(blockKey, latestDate);
  else settlementBlocked.delete(blockKey);
  // No requested day was actually published. Leave the cursor untouched so
  // the holding can retry instead of permanently losing those earnings.
  if (!settledThrough) return 0;

  const newEscrowTotal = (holding.escrowedEarned || 0) + escrowDelta;
  const amountTriggered = newEscrowTotal >= ESCROW_FLAG_AMOUNT;
  const streakTriggered = streakDays >= ESCROW_FLAG_STREAK_DAYS;
  const shouldFlag = !holding.escrowFlagged && (amountTriggered || streakTriggered);
  // Recorded once, at the exact moment a holding transitions to flagged, so
  // a reviewer sees what ACTUALLY triggered it - escrowedEarned/streakDays
  // keep changing after that point (settlement doesn't stop just because a
  // holding is flagged), so recomputing "why" from current numbers later
  // could give a different, misleading answer than what really happened.
  const flagReason = shouldFlag ? (amountTriggered && streakTriggered ? "both" : amountTriggered ? "amount" : "streak") : null;

  // Compare-and-set on the old settle date: if a concurrent request already
  // settled this window, applied === false and we must not credit again.
  const applied = await store.applySettlement(
    holding.id,
    holding.lastSettledDate,
    settledThrough,
    earned,
    latestEarned,
    escrowDelta,
    streakDays,
    shouldFlag,
    flagReason,
    shouldFlag ? Date.now() : null
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
  // Notify on latestEarned (just the most-recently-settled day's credit),
  // not the full possibly-multi-day `earned` sum - this is what "today's
  // earnings" means everywhere else in the app (see todayEarnings in
  // portfolio()). Keyed by settledThrough so every holding that settles for
  // the same day adds into one running per-user notification instead of
  // spamming one per holding.
  if (latestEarned > 0) {
    await pushNotification(holding.userId, {
      type: "daily-earnings",
      amount: latestEarned,
      dedupKey: `earn:${settledThrough}`,
    });
  }
  if (shouldFlag) {
    console.warn(
      `Holding ${holding.id} (${holding.article}) flagged for manual escrow review: ` +
        `escrow=${newEscrowTotal} streak=${streakDays}d - see /api/admin/escrow.`
    );
    // Fire-and-forget: the flag itself (and the credited earnings above) are
    // already committed, so a slow or failed AI check must never hold up
    // settlement. Only fires at the exact flag transition (guarded by
    // `applied`), same as flagReason/flaggedAt - never re-runs on every
    // subsequent settle pass while the holding stays flagged.
    checkSpike({
      article: holding.article,
      displayTitle: holding.displayTitle,
      lang: holding.lang,
      date: settledThrough,
      amount: newEscrowTotal,
      streakDays,
      reason: flagReason,
    })
      .then((result) => store.setSpikeCheck(holding.id, result))
      .catch((err) => console.error(`Spike check failed for holding ${holding.id}:`, err));
  }
  return earned;
}

/**
 * Recover holdings affected by the old empty-response bug. The repair is
 * deliberately narrow: only legacy holdings that advanced beyond their
 * purchase date while still having zero lifetime earnings are eligible, and
 * the repair is applied once with a store-level atomic guard.
 */
export async function repairZeroSettlement(holding) {
  if (
    holding.earningsRepaired ||
    holding.totalEarned !== 0 ||
    holding.purchasedDate >= holding.lastSettledDate
  ) {
    return 0;
  }

  const start = addDaysUTC(parseDate(holding.purchasedDate), 1);
  const end = parseDate(holding.lastSettledDate);
  // Extra lookback for the same rolling-baseline cap the normal settlement
  // path applies (see EARNINGS_BASELINE_WINDOW_DAYS) - a historical window
  // being repaired shouldn't pay out an uncapped amount just because it's
  // old. Any excess above the cap here is simply not credited rather than
  // escrowed: this repair path is a narrow, one-time catch-up for a small
  // set of legacy holdings, not worth the extra bookkeeping for.
  const fetchStart = addDaysUTC(start, -EARNINGS_BASELINE_WINDOW_DAYS);
  const views = await fetchDailyPageviews(
    holding.project,
    holding.article,
    fetchStart,
    end
  );
  const { earned, latestEarned, settledThrough } = contiguousSettlement(
    views,
    start,
    end
  );
  // Wait until the entire historical window is available; a partial repair
  // would recreate the same permanent data loss this path is correcting.
  if (settledThrough !== holding.lastSettledDate) return 0;

  const applied = await store.applyEarningsRepair(
    holding.id,
    holding.lastSettledDate,
    earned,
    latestEarned
  );
  if (!applied || earned === 0) return 0;

  await store.addCredits(holding.userId, earned);
  await logEvent(holding.userId, "earn", {
    article: holding.article,
    displayTitle: holding.displayTitle,
    amount: earned,
  });
  return earned;
}

/** Settle every holding for a user. Returns total credits earned this pass. */
export async function settleUser(userId) {
  const holdings = await store.holdingsForUser(userId);
  // Settle all holdings concurrently rather than awaiting each in turn - a
  // user with many pages otherwise pays for N sequential Wikimedia round
  // trips before the portfolio (and therefore /api/me) can return. Repair
  // must still precede settle for the *same* holding, but holdings are
  // independent of one another; downstream fetches stay throttled by
  // withPageviewsLimit, and each holding's credit update is atomic.
  const earned = await Promise.all(
    holdings.map(async (h) => {
      try {
        const repaired = await repairZeroSettlement(h);
        const settled = await settleHolding(h);
        return repaired + settled;
      } catch (err) {
        console.error("settle failed for", h.key, err);
        return 0;
      }
    })
  );
  return earned.reduce((sum, n) => sum + n, 0);
}

// One settlement pass per user at a time. /api/me is hit by page load, by
// the post-trade refresh, and by the frontend's own retries - without this,
// a slow pass gets duplicated by every one of those instead of joined, and
// each duplicate re-does the same Wikimedia work.
const inflightSettles = new Map(); // userId -> Promise
function settleOnce(userId) {
  let pass = inflightSettles.get(userId);
  if (!pass) {
    pass = (async () => {
      await settleUser(userId);
      await settleBets(userId);
    })().finally(() => inflightSettles.delete(userId));
    pass.catch(() => {}); // a caller may stop waiting on it; never leave it unhandled
    inflightSettles.set(userId, pass);
  }
  return pass;
}

// Settlement is idempotent and compare-and-set guarded, so it's safe to stop
// WAITING on a pass without stopping the pass: whatever doesn't finish in
// time keeps running and lands on a later load. What isn't safe is letting a
// slow Wikimedia day hold /api/me open past the frontend's request timeout -
// that's what leaves the app stuck on "Checking your session..." until the
// user refreshes. Answer with the state we have instead; the `settling` flag
// on the response (see portfolio()) tells the frontend to quietly re-poll
// rather than leave a manual refresh as the only way to see the real numbers.
const SETTLE_DEADLINE_MS = 8000;

// Resolves to true if `ms` elapsed before `promise` did (i.e. the caller gave
// up waiting), false if `promise` won the race.
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(false);
    };
    promise.then(done, done);
  });
}

/**
 * Build the portfolio view: each holding with its live current price, plus
 * account totals (credits, net worth). Prices are fetched (cached) live.
 */
export async function portfolio(userId) {
  const settling = await withDeadline(settleOnce(userId), SETTLE_DEADLINE_MS);
  const user = await store.getUser(userId);
  const holdings = await store.holdingsForUser(userId);
  // A listing's id is its holding's id, so this naturally only matches
  // holdings this user owns - no need to filter by seller separately.
  const listingById = new Map((await store.allActiveListings()).map((l) => [l.id, l]));

  const latestSettledDate = fmtDate(latestAvailableDate());

  // Price every holding concurrently instead of awaiting them one-by-one -
  // the sequential version made this loop cost N round trips (a DB cache hit
  // at best, a full year-pageview fetch on a cold cache), which is the bulk
  // of what made /api/me slow to return. Wikimedia calls stay throttled by
  // withPageviewsLimit downstream.
  const prices = await Promise.all(
    holdings.map(async (h) => {
      // allowStale: serve the last cached price instantly and refresh in the
      // background. Every owned page was priced at purchase, so this loop
      // never blocks on a live fetch during normal use - it just reads the
      // DB. If pricing is temporarily unavailable, show the last verified
      // price (what they paid) instead of a bogus 1.
      try {
        const p = await getPagePrice(h.project, h.article, { allowStale: true });
        return p.unpriced ? null : p;
      } catch {
        return null; // treat as unpriced
      }
    })
  );

  const items = [];
  let holdingsValue = 0;
  let todayEarnings = 0;
  let totalEarned = 0;
  // lastSettledDate < latestSettledDate means this holding has an elapsed day
  // it's eligible to earn for, but settlement hasn't credited it yet - almost
  // always because Wikimedia hasn't published that day's numbers for this
  // article yet (publish lag isn't uniform across articles - some land hours
  // before others). That's a "we don't know yet", not "you earned nothing" -
  // todayEarningsPending lets the frontend show "Pending" instead of a
  // misleadingly-final 0 during that window.
  let todayEarningsPending = false;
  holdings.forEach((h, i) => {
    const price = prices[i];
    const current = price ? price.annualPrice : h.purchasePrice;
    holdingsValue += current;
    // This is persisted from the successful settlement itself. Live/cached
    // readership belongs in latestViews; it must never masquerade as points.
    if (h.lastSettledDate >= latestSettledDate) {
      todayEarnings += h.latestEarned || 0;
    } else {
      todayEarningsPending = true;
    }
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
      // Surfaced so the owner isn't left wondering where a real traffic
      // spike's earnings went - see the anti-botting cap in
      // contiguousSettlement. Held earnings are never silently dropped.
      escrowedEarned: h.escrowedEarned || 0,
      escrowFlagged: !!h.escrowFlagged,
    });
  });
  items.sort((a, b) => b.currentPrice - a.currentPrice);

  return {
    user: publicUser(user),
    holdings: items,
    holdingsValue,
    todayEarnings,
    todayEarningsPending,
    totalEarned,
    netWorth: user.credits + holdingsValue,
    // True when the settlement pass hadn't finished by SETTLE_DEADLINE_MS, so
    // this response was built from whatever was already credited - a real
    // settle that's still catching up on Wikimedia round trips, still
    // running in the background. Distinct from todayEarningsPending (which
    // means Wikimedia itself has no data yet): this means we have the data
    // but haven't necessarily applied it to what's shown here yet. The
    // frontend uses it to quietly re-poll instead of leaving a manual
    // refresh as the only way to see the credited amount.
    settling,
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
  // See MIN_ARTICLE_AGE_DAYS: a brand-new article can spike purely off
  // novelty before it has any real readership track record. Checked before
  // pricing so a rejected article doesn't also cost a live Wikimedia price
  // fetch.
  const createdAt = await getPageCreationDate(article);
  if (!createdAt) {
    throw new Error(
      "Couldn't verify this article's age right now. Try again in a few seconds."
    );
  }
  const ageDays = Math.floor((Date.now() - createdAt.getTime()) / 86400000);
  if (ageDays < MIN_ARTICLE_AGE_DAYS) {
    throw new Error(
      `This article is too new to buy - it must be at least ${MIN_ARTICLE_AGE_DAYS} days old ` +
        `(created ${ageDays === 1 ? "1 day" : `${ageDays} days`} ago).`
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
    latestEarned: 0,
    earningsRepaired: true,
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

/**
 * Loot box: pay a flat fee for a random, currently-unclaimed Wikipedia
 * article instead of picking one deliberately. Unlike buyPage, the price
 * paid has no relation to the article's actual value - that mismatch (walk
 * away with an obscure stub, or a page worth many times the fee) is the
 * entire point. The holding's purchasePrice is recorded as the flat fee, not
 * the article's real price, so the portfolio's gain/loss immediately
 * reflects how the roll went.
 */
// getRandomArticles draws uniformly from ALL ~6.8M English articles (no
// popularity filter), and Wikipedia's traffic is a brutal long tail - a real
// sample of that pool priced a median article at only ~50-65 pts, with 96%
// of draws worth less than the old 5,000-pt cost (== the entire starting
// balance). 100 sits near that median: most pulls land close to breakeven,
// the fat tail of occasional four/five-figure articles still makes for real
// jackpots, and losing a bad roll no longer costs a meaningful chunk of a
// new player's whole balance.
export const LOOTBOX_COST = 100;

// The site owner's account can open loot boxes for free (for testing/demoing
// without burning real credits) - everyone else pays the normal cost.
// Matched by username, not email: `email` is only populated at account
// creation or via the one-time scripts/backfill-emails.js migration, so an
// account created before either of those ran can have no email on file at
// all. `username` has no such gap - it's always set (a generated placeholder
// until the mandatory first-sign-in prompt, the real chosen name after).
const FREE_LOOTBOX_USERNAMES = new Set(["jbrahms"]);

function isFreeLootboxAccount(user) {
  return !!user?.username && FREE_LOOTBOX_USERNAMES.has(user.username.toLowerCase());
}

// What GET /api/lootbox shows before anyone commits to opening one - needs
// its own lookup since, unlike openLootBox, there's no other reason to have
// fetched the user yet.
export async function lootboxCostFor(userId) {
  if (!userId) return LOOTBOX_COST;
  return isFreeLootboxAccount(await store.getUser(userId)) ? 0 : LOOTBOX_COST;
}

// Wikipedia's random endpoint can hand back an article someone already
// claimed, or one Wikimedia can't currently price - retry with a fresh
// random pick rather than fail the whole box on the first miss.
const LOOTBOX_MAX_ATTEMPTS = 8;

export async function openLootBox(userId) {
  const user = await store.getUser(userId);
  // purchasePrice below must reflect what was actually paid, not the list
  // price - a free pull's gain/loss is measured against a real cost of 0.
  const cost = isFreeLootboxAccount(user) ? 0 : LOOTBOX_COST;

  let creditsLeft = user ? user.credits : 0;
  if (cost > 0) {
    creditsLeft = await store.tryDebit(userId, cost);
    if (creditsLeft === null) {
      throw new Error(
        `Not enough credits: a loot box costs ${LOOTBOX_COST}, you have ${user ? user.credits : 0}.`
      );
    }
  }

  for (let attempt = 0; attempt < LOOTBOX_MAX_ATTEMPTS; attempt++) {
    const [candidate] = await getRandomArticles(1);
    if (!candidate) continue;
    if (await store.findAnyHolding("en.wikipedia", candidate.article)) continue;

    // Same MIN_ARTICLE_AGE_DAYS gate as a direct buy - a random pull
    // shouldn't be able to hand out a novelty-spiking new article either.
    // Unlike buyPage, an unknown age here just means "try another
    // candidate" rather than failing the whole box.
    const createdAt = await getPageCreationDate(candidate.article);
    if (!createdAt || (Date.now() - createdAt.getTime()) / 86400000 < MIN_ARTICLE_AGE_DAYS) continue;

    let price;
    try {
      price = await getPagePrice("en.wikipedia", candidate.article, { force: true });
    } catch {
      continue;
    }
    if (price.unpriced) continue;

    const today = fmtDate(latestAvailableDate());
    const holding = {
      id: uid(),
      userId,
      project: "en.wikipedia",
      article: candidate.article,
      displayTitle: candidate.title,
      lang: "en",
      key: `en.wikipedia::${candidate.article}`,
      purchasePrice: cost,
      purchasedDate: today,
      lastSettledDate: today,
      totalEarned: 0,
      latestEarned: 0,
      earningsRepaired: true,
    };
    const created = await store.createHoldingIfUnowned(holding);
    if (!created) continue; // lost a race to a concurrent claimant - try another article

    await logEvent(userId, "lootbox", {
      article: candidate.article,
      displayTitle: candidate.title,
      amount: cost,
    });
    return {
      holding,
      cost,
      marketValue: price.annualPrice,
      // Same live-price fields the article detail page shows - lets the
      // result card be a real "here's what you got" view, not just a name.
      changePct: price.changePct,
      latestViews: price.latestViews,
      spark: price.spark || null,
      pendingLatest: !!price.pendingLatest,
      creditsLeft,
    };
  }

  // Never landed on a claimable article - refund rather than charge for nothing.
  if (cost > 0) {
    await store.addCredits(userId, cost);
    throw new Error(
      "Couldn't find an unclaimed article to give you right now. Your credits have been refunded - try again."
    );
  }
  throw new Error("Couldn't find an unclaimed article to give you right now. Try again.");
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
 * Notification center: private, per-user alerts (today's earnings, an
 * escrow decision, ...) - distinct from recentActivity, which is a public
 * feed of everyone's trades. Extensible by `type`; the frontend renders
 * each type's text from amount/article/displayTitle/data (see notifText in
 * public/app.js). Never lets a notification failure break the caller (a
 * credit/settlement) that triggered it.
 */
async function pushNotification(userId, { type, amount = null, article = null, displayTitle = null, data = null, dedupKey = null }) {
  try {
    await store.addOrIncrementNotification({
      id: uid(),
      userId,
      type,
      amount,
      article,
      displayTitle,
      data,
      dedupKey,
      ts: Date.now(),
    });
  } catch (err) {
    console.error("notification failed:", err);
  }
}

export async function listNotifications(userId, limit = 30) {
  return store.notificationsForUser(userId, limit);
}

export async function unreadNotificationCount(userId) {
  return store.unreadNotificationCount(userId);
}

export async function markNotificationRead(userId, id) {
  const applied = await store.markNotificationRead(id, userId);
  if (!applied) throw new Error("Notification not found.");
  return { read: true };
}

export async function markAllNotificationsRead(userId) {
  await store.markAllNotificationsRead(userId);
  return { read: true };
}

/** Called after an admin resolves a flagged holding's escrow (release or
 * forfeit) - see /api/admin/escrow/:id/release|forfeit in server.js. */
export async function notifyEscrowResolved({ userId, article, displayTitle, amount, credited }) {
  if (amount <= 0) return;
  await pushNotification(userId, {
    type: credited ? "escrow-released" : "escrow-forfeited",
    amount,
    article,
    displayTitle,
  });
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
    latestEarned: 0,
    earningsRepaired: true,
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
 * Predictions: guess tomorrow's exact daily view count for an article (the
 * same number shown elsewhere as "Views (24h)") rather than just its
 * direction. A plain up/down call on a trending page was near-free money
 * (see the old comment here about price's built-in drift - raw daily views
 * don't have that problem, but direction alone is still a coin flip once
 * you already know the trend). Guessing the actual number takes a real read
 * on the article, and the tolerance for "close enough" scales with how much
 * that specific article's traffic naturally moves day to day - see
 * betBand(). Stake is escrowed (debited) immediately; payout is settled
 * lazily, the same pattern as holdings - no cron, resolved whenever the
 * bettor is next active, past-due bets are just caught up on read.
 *
 * Betting is gated to articles with real, checkable traffic
 * (MIN_BET_BASELINE_VIEWS) so a near-zero-traffic page - where a handful of
 * refreshes can move the daily count by 1000%+ - can't be bet on at all.
 * Even above that floor, the view count actually used to grade a bet is
 * capped at BET_MAX_GRADED_MULTIPLE times the article's pre-bet baseline
 * (see resolveBetIfDue), so inflating an obscure article's traffic to chase
 * your own guess stops paying off well past the point it'd look organic.
 */
const BET_DURATION_MS = 24 * 60 * 60 * 1000;
const MIN_STAKE = 1;

// How much history informs an article's baseline traffic and volatility.
const BET_HISTORY_DAYS = 14;
const MIN_BET_HISTORY_DAYS = 5; // too little data to trust a baseline/band

const MIN_BET_BASELINE_VIEWS = 50;

// Payout curve: full payout inside half the article's typical daily swing
// (band), falling linearly to zero by twice that swing. The band itself is
// clamped so a dead-flat article doesn't demand a pixel-perfect guess, and
// an extremely spiky one doesn't hand out full payout for nearly any guess.
const BET_BAND_FLOOR = 0.08;
const BET_BAND_CEILING = 0.75;
const BET_BAND_INNER = 0.5; // x band = still full payout
const BET_BAND_OUTER = 2; // x band = payout hits zero
const BET_MAX_PAYOUT_MULTIPLE = 3; // stake multiplier at/inside the inner band

// Caps the view count used to grade a bet at this multiple of the article's
// pre-bet baseline - "the number has to increase by a lot to count", but not
// unboundedly, so self-inflating an obscure article's traffic buys nothing
// once it's past ~1000% over its own normal level.
const BET_MAX_GRADED_MULTIPLE = 11; // 11x baseline = +1000%

function betBand(sigma) {
  return Math.min(BET_BAND_CEILING, Math.max(BET_BAND_FLOOR, sigma));
}

function betPayoutMultiple(relError, band) {
  if (relError <= BET_BAND_INNER * band) return BET_MAX_PAYOUT_MULTIPLE;
  if (relError >= BET_BAND_OUTER * band) return 0;
  const span = (BET_BAND_OUTER - BET_BAND_INNER) * band;
  return BET_MAX_PAYOUT_MULTIPLE * (1 - (relError - BET_BAND_INNER * band) / span);
}

export async function placeBet(userId, { project, article, displayTitle, guess, stake }) {
  stake = Math.round(Number(stake));
  if (!Number.isFinite(stake) || stake < MIN_STAKE) {
    throw new Error(`Minimum prediction stake is ${MIN_STAKE} point.`);
  }
  guess = Math.round(Number(guess));
  if (!Number.isFinite(guess) || guess < 0) {
    throw new Error("Enter a valid guess for tomorrow's view count.");
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

  const history = await getArticleHistory(project, article, BET_HISTORY_DAYS);
  if (history.length < MIN_BET_HISTORY_DAYS) {
    throw new Error("Not enough traffic history for this article to predict on yet.");
  }
  const baselineAvg = history.reduce((sum, d) => sum + d.views, 0) / history.length;
  if (baselineAvg < MIN_BET_BASELINE_VIEWS) {
    throw new Error(
      `This article doesn't get enough traffic to predict on (needs an average of at least ${MIN_BET_BASELINE_VIEWS} views/day - it's getting about ${Math.round(baselineAvg)}).`
    );
  }
  // Typical day-to-day relative swing, averaged over every consecutive pair
  // in the history window - this is what sets how forgiving the guess needs
  // to be for THIS article (see betBand).
  let sigmaSum = 0;
  let sigmaCount = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].views;
    if (prev > 0) {
      sigmaSum += Math.abs(history[i].views - prev) / prev;
      sigmaCount++;
    }
  }
  const sigma = sigmaCount ? sigmaSum / sigmaCount : BET_BAND_CEILING;
  const band = betBand(sigma);

  // startViews came from latestAvailableDate() (Wikimedia's ~1-day publish
  // lag means that's always "yesterday", already final by the time we can
  // read it) - the bet is really "what will the NEXT day's views be", so
  // targetDate is the specific calendar day whose figure settles it, not
  // just "24 hours from now".
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
    guess,
    stake,
    startViews,
    baselineAvg,
    band,
    targetDate,
    placedAt: now,
    resolvesAt: now + BET_DURATION_MS, // kept as a display estimate - actual resolution can land earlier
    status: "open",
    endViews: null,
    gradedViews: null,
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
 * scales with how close the guess was, within the band computed at bet
 * placement (see placeBet) - closer than half the band pays the max
 * multiple, farther than twice the band pays nothing (floored at 0 - you
 * can't lose more than you staked). The view count used to grade a guess is
 * capped at BET_MAX_GRADED_MULTIPLE times the article's pre-bet baseline, so
 * inflating traffic to chase your own guess stops helping well before it
 * would matter. A Wikimedia hiccup at resolution time refunds the stake
 * instead of penalizing the player for an API outage.
 */
async function resolveBetIfDue(bet) {
  if (bet.status !== "open") return null;
  const targetDate = targetDateFor(bet);

  // Cheap date-only check first, no API call: the target day can't possibly
  // be published until it's at least become "yesterday" for real.
  if (formatYYYYMMDD(latestAvailableDate()) < targetDate) return null;

  const giveUp = Date.now() >= bet.resolvesAt + RESOLUTION_GRACE_MS;
  let endViews = bet.startViews;
  let published = false;
  try {
    const target = parseDate(targetDate);
    const views = await fetchDailyPageviews(bet.project, bet.article, target, target);
    const raw = views.get(targetDate);
    if (raw == null) {
      // The day has rolled over but Wikimedia hasn't actually published it
      // yet - keep waiting for a later settle pass unless we've given it a
      // full extra day of grace already.
      if (!giveUp) return null;
      // Past the grace period: unknowable, so refund rather than guess.
    } else {
      endViews = Math.max(1, raw);
      published = true;
    }
  } catch {
    if (!giveUp) return null;
    /* unpublished/unknowable -> refund below */
  }

  let payout;
  let gradedViews = null;
  // Bets placed before the exact-guess mechanic shipped only have a
  // direction, not a guess - resolve those the old way instead of grading
  // them by rules they were never placed under.
  const isLegacyDirectionBet = bet.guess == null && bet.direction != null;
  if (!published) {
    payout = bet.stake; // unknowable - refund rather than guess
  } else if (isLegacyDirectionBet) {
    const pctChange = (endViews - bet.startViews) / bet.startViews;
    const signedPct = bet.direction === "up" ? pctChange : -pctChange;
    payout = Math.max(0, Math.round(bet.stake * (1 + signedPct)));
  } else {
    const baselineAvg = bet.baselineAvg || bet.startViews;
    const cap = Math.max(1, Math.round(baselineAvg * BET_MAX_GRADED_MULTIPLE));
    gradedViews = Math.min(endViews, cap);
    const relError = Math.abs(bet.guess - gradedViews) / Math.max(1, gradedViews);
    const band = bet.band || BET_BAND_CEILING;
    payout = Math.round(bet.stake * betPayoutMultiple(relError, band));
  }

  const applied = await store.resolveBet(bet.id, {
    endViews,
    gradedViews,
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
  // Resolve concurrently - same reasoning as settleUser: bets are
  // independent and each due one may hit Wikimedia, so awaiting them
  // in sequence needlessly serializes those round trips.
  await Promise.all(
    open.map(async (b) => {
      try {
        await resolveBetIfDue(b);
      } catch (err) {
        console.error("bet resolution failed for", b.id, err);
      }
    })
  );
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
