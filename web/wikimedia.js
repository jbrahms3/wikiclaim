// Talks to public Wikimedia/Wikipedia APIs: article search, pricing (average
// daily pageviews), and per-day view counts used for settlement.
import { store } from "./store.js";

const PAGEVIEWS_BASE =
  "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";

// Wikimedia asks that REST clients send a descriptive User-Agent.
const UA = "WikiClaim/1.0 (https://github.com/local/wikiclaim; game demo)";

const PREMIUM_WINDOW_DAYS = 30;
const YEAR_WINDOW_DAYS = 365;
// The purchase price blends a full year's typical daily traffic with a
// recency premium - like valuing a business at its normal yearly run-rate
// plus a bonus for a strong last month. avgViews = daily average over the
// last YEAR_WINDOW_DAYS days (the baseline "views/day" figure shown
// everywhere); premium = raw view total over the last PREMIUM_WINDOW_DAYS
// days (not averaged - a real recent-traffic bonus, not a daily rate).
// annualPrice = avgViews + premium is the only number that's the actual
// price. Everything else (latestViews, changePct, spark, "Views (24h)" in
// the UI) stays a genuine daily figure from the same fetch.
const PRICE_CACHE_MS = 6 * 60 * 60 * 1000; // re-price a page at most every 6h
// Results that came back with no data at all get a much shorter TTL. Under
// concurrent load, Wikimedia's pageviews API sometimes returns 404 (rather
// than 429) for articles that plainly have traffic - so a "no data" result
// is not fully trustworthy and shouldn't poison the cache for 6 hours if
// it was actually a transient rate-limit response.
const EMPTY_CACHE_MS = 3 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cap how many pageviews requests are in flight at once. Firing 20-30 at
// once (e.g. pricing every article in the category-index baskets) reliably
// triggers rate limiting from Wikimedia, which is the root cause above.
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  function pump() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { run, resolve, reject } = queue.shift();
    run().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
  return (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      pump();
    });
}
const withPageviewsLimit = createLimiter(4);

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatYYYYMMDD(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}
export function todayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export function addDaysUTC(d, days) {
  return new Date(d.getTime() + days * 86400000);
}
export function parseDate(yyyymmdd) {
  return new Date(
    Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6, 8))
    )
  );
}
// Pageview data is published with a lag; the previous UTC day is the safest
// "latest available" for most articles.
export function latestAvailableDate() {
  return addDaysUTC(todayUTC(), -1);
}

export function pageKey(project, article) {
  return `${project}::${article}`;
}

// encodeURIComponent leaves !'()* literal, but the Wikimedia pageviews API
// needs the apostrophe (and, to be safe, the others) percent-encoded — a raw
// "'" in a title like Côte_d'Ivoire causes intermittent 404s.
function encodeArticle(article) {
  return encodeURIComponent(article).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Fetch daily view counts (human traffic only) for [start, end] inclusive.
 * Returns Map<"YYYYMMDD", views>. A 404 (after retries) means "no data".
 */
export async function fetchDailyPageviews(project, article, start, end) {
  if (start > end) return new Map();
  const s = `${formatYYYYMMDD(start)}00`;
  const e = `${formatYYYYMMDD(end)}00`;
  const url = `${PAGEVIEWS_BASE}/${project}/all-access/user/${encodeArticle(
    article
  )}/daily/${s}/${e}`;

  // Wikimedia's edge cache sometimes serves a bogus 404 for articles that
  // have data (confirmed live: Star_Wars_(film) 404'd while the same URL
  // with a junk query param returned 200), and that 404 is itself cached
  // with s-maxage=600 - so plain retries of the same URL just replay the
  // poisoned cache entry for up to 10 minutes. Retries therefore append a
  // throwaway query param: the query string is part of the edge cache key,
  // which punches through to the real backend. First attempt stays clean so
  // we still benefit from the cache when it's healthy.
  const RETRY_DELAYS_MS = [300, 1000, 2500];
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const u = attempt === 0 ? url : `${url}?cachebust=${Date.now()}_${attempt}`;
    const res = await withPageviewsLimit(() =>
      fetch(u, { headers: { Accept: "application/json", "User-Agent": UA } })
    );

    if (res.ok) {
      const data = await res.json();
      const out = new Map();
      for (const item of data.items || []) {
        const day = item.timestamp.slice(0, 8);
        out.set(day, (out.get(day) || 0) + item.views);
      }
      return out;
    }

    const retryable = res.status === 404 || res.status === 429;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.status === 404) return new Map();
    throw new Error(`Pageviews API ${res.status} for ${project}/${article}`);
  }
  return new Map();
}

/**
 * Prices an article. avgViews (daily average over the last YEAR_WINDOW_DAYS
 * days, minimum 1) is the baseline "views/day" figure; premium (raw view
 * total over the last PREMIUM_WINDOW_DAYS days) is added on top as a recency
 * bonus. annualPrice = avgViews + premium is the actual purchase/sale price.
 * Cached for a few hours.
 */
// A cached entry with no real signal at all (every one of the last 7 days
// literally 0, floored to the price minimum) is treated as suspect rather
// than trusted for the full TTL - see EMPTY_CACHE_MS. spark is the reliable
// signal here (always computed the same way, no fallback quirks).
function looksEmpty(entry) {
  return entry.avgViews <= 1 && entry.spark && entry.spark.every((v) => v === 0);
}

// avgViews and premium are both persisted - they come from different windows
// of the same underlying fetch and can't be derived from each other.
// annualPrice is the only field derived fresh on every read (never persisted
// itself), and unpriced depends on spark/avgViews so it must be recomputed
// even for a cache hit (an all-zero window means "the API gave us nothing",
// not "worth 1").
function withDerived(entry) {
  return {
    ...entry,
    unpriced: looksEmpty(entry),
    annualPrice: entry.avgViews + (entry.premium || 0),
  };
}

// Coalesce concurrent lookups for the same article into one upstream fetch —
// e.g. the trending list and the category baskets overlap on several titles
// and fire at the same time on a cold cache.
const inflightPrices = new Map(); // key -> Promise<entry>

export async function getPagePrice(project, article, { force = false } = {}) {
  const key = pageKey(project, article);
  const cached = await store.getPageCache(key);
  const ttl = cached && looksEmpty(cached) ? EMPTY_CACHE_MS : PRICE_CACHE_MS;
  if (!force && cached && Date.now() - cached.updatedAt < ttl) {
    return withDerived(cached);
  }

  if (inflightPrices.has(key)) return inflightPrices.get(key);
  const promise = fetchAndCachePrice(key, project, article).finally(() =>
    inflightPrices.delete(key)
  );
  inflightPrices.set(key, promise);
  return promise;
}

async function fetchAndCachePrice(key, project, article) {
  const end = latestAvailableDate();
  const start = addDaysUTC(end, -(YEAR_WINDOW_DAYS - 1));
  const views = await fetchDailyPageviews(project, article, start, end);

  let yearSum = 0;
  for (const v of views.values()) yearSum += v;
  const avgViews = Math.max(1, Math.round(yearSum / YEAR_WINDOW_DAYS));

  // Recency premium: a raw total (not a daily rate) over the last
  // PREMIUM_WINDOW_DAYS days, added straight onto the yearly baseline.
  let premium = 0;
  for (let i = 0; i < PREMIUM_WINDOW_DAYS; i++) {
    premium += views.get(formatYYYYMMDD(addDaysUTC(end, -i))) || 0;
  }
  const premiumAvg = premium / PREMIUM_WINDOW_DAYS;

  // Only fall back to the recent average when we have *some* data but happen
  // to be missing just the most recent day (publishing lag) - not when the
  // whole window came back empty, which should read as "0 views", not "avg views".
  const latestViews = views.size > 0 ? views.get(formatYYYYMMDD(end)) ?? Math.round(premiumAvg) : 0;
  // "Change" = today vs. the last-30-days average, like a stock's move
  // relative to a short moving average (not the full-year baseline the price
  // is anchored to). Guarded against #DIV/0 when the last 30 days are all 0.
  const changePct = premiumAvg > 0 ? ((latestViews - premiumAvg) / premiumAvg) * 100 : 0;

  // Last 7 available days, oldest first — free sparkline data from the same fetch.
  const spark = [];
  for (let i = 6; i >= 0; i--) {
    spark.push(views.get(formatYYYYMMDD(addDaysUTC(end, -i))) || 0);
  }

  const entry = {
    key,
    project,
    article,
    avgViews,
    premium,
    latestViews,
    changePct: Math.round(changePct * 10) / 10,
    spark,
    windowDays: YEAR_WINDOW_DAYS,
    updatedAt: Date.now(),
  };
  await store.setPageCache(entry);
  return withDerived(entry);
}

/**
 * Daily view counts for the last `days` available days, oldest first —
 * chart-ready. In-memory cached (30 min) since portfolio charts sum one
 * series per holding and detail pages re-request on range switches.
 */
const historyCache = new Map(); // key -> { at, data }
const HISTORY_CACHE_MS = 30 * 60 * 1000;

export async function getArticleHistory(project, article, days = 30) {
  const cacheKey = `${project}::${article}::${days}`;
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_CACHE_MS) return hit.data;

  const end = latestAvailableDate();
  const start = addDaysUTC(end, -(days - 1));
  const views = await fetchDailyPageviews(project, article, start, end);

  const out = [];
  let cursor = start;
  while (cursor <= end) {
    const key = formatYYYYMMDD(cursor);
    out.push({ date: key, views: views.get(key) || 0 });
    cursor = addDaysUTC(cursor, 1);
  }
  historyCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}

/**
 * Batch-fetch page thumbnails + short descriptions from the MediaWiki API.
 * Takes URL-form titles (underscores), returns Map<article, {thumbnail, description}>.
 * In-memory cached 24h — images and descriptions barely change.
 */
const metaCache = new Map(); // article -> { at, meta }
const META_CACHE_MS = 24 * 60 * 60 * 1000;

export async function getPageMeta(articles) {
  const result = new Map();
  const missing = [];
  for (const a of articles) {
    const hit = metaCache.get(a);
    if (hit && Date.now() - hit.at < META_CACHE_MS) result.set(a, hit.meta);
    else missing.push(a);
  }

  // MediaWiki caps titles= at 50 per request.
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const url =
        "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query",
          prop: "pageimages|description",
          pithumbsize: "160",
          titles: batch.map((a) => a.replace(/_/g, " ")).join("|"),
          redirects: "1",
          format: "json",
          origin: "*",
        });
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json();

      // Map normalized/redirected titles back to what we asked for.
      const back = new Map(); // resolved title -> requested article
      for (const a of batch) back.set(a.replace(/_/g, " "), a);
      for (const n of data.query?.normalized || []) {
        const orig = back.get(n.from);
        if (orig) back.set(n.to, orig);
      }
      for (const r of data.query?.redirects || []) {
        const orig = back.get(r.from);
        if (orig) back.set(r.to, orig);
      }

      for (const page of Object.values(data.query?.pages || {})) {
        const requested = back.get(page.title);
        if (!requested) continue;
        const meta = {
          thumbnail: page.thumbnail?.source || null,
          description: page.description || null,
        };
        metaCache.set(requested, { at: Date.now(), meta });
        result.set(requested, meta);
      }
    } catch {
      /* thumbnails are decoration; never fail the caller */
    }
  }
  return result;
}

/**
 * Category "indexes" for the header ticker — each is the average price
 * (30-day avg daily views) of a fixed basket of representative articles,
 * like a sector index is a basket of stocks. All real pageview data.
 */
export const CATEGORY_BASKETS = {
  Science: ["Black_hole", "Albert_Einstein", "DNA", "Quantum_mechanics"],
  Technology: ["Artificial_intelligence", "ChatGPT", "Bitcoin", "IPhone"],
  History: ["World_War_II", "Roman_Empire", "French_Revolution", "Cold_War"],
  Culture: ["Taylor_Swift", "Minecraft", "Marvel_Cinematic_Universe", "K-pop"],
  Sports: ["Cristiano_Ronaldo", "Lionel_Messi", "LeBron_James", "Formula_One"],
  Geography: ["United_States", "India", "Japan", "Earth"],
};

export async function getCategoryIndexes() {
  const out = [];
  await Promise.all(
    Object.entries(CATEGORY_BASKETS).map(async ([name, basket]) => {
      const prices = (
        await Promise.all(
          basket.map((a) => getPagePrice("en.wikipedia", a).catch(() => null))
        )
      ).filter((p) => p && !p.unpriced);
      if (!prices.length) return;

      const value = Math.round(
        prices.reduce((s, p) => s + p.avgViews, 0) / prices.length
      );
      const changePct =
        Math.round(
          (prices.reduce((s, p) => s + (p.changePct || 0), 0) / prices.length) * 10
        ) / 10;
      // Element-wise sum of member sparklines -> index sparkline.
      const spark = [0, 0, 0, 0, 0, 0, 0];
      for (const p of prices) {
        (p.spark || []).forEach((v, i) => (spark[i] += v));
      }
      out.push({ name, value, changePct, spark });
    })
  );
  // Promise.all scrambles completion order; keep the declared order.
  const order = Object.keys(CATEGORY_BASKETS);
  out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return out;
}

// Real "trending" = Wikimedia's actual top-viewed-articles list for a day,
// not a fixed guess at what's popular. One request gets the top 1000 ranked
// by genuine traffic, so this reflects real-world events instead of always
// showing the same handful of titles.
const TOP_LIST_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top";
const TOP_LIST_CACHE_MS = 3 * 60 * 60 * 1000; // the ranked list itself barely shifts within a day

// Wikimedia namespace prefixes and meta pages aren't tradable articles.
const NON_ARTICLE = /^(Special|Wikipedia|File|Category|Template|Portal|Help|Talk|User|Draft|Module|MediaWiki|TimedText|Book)(_talk)?:/i;

let topListCache = null; // { at, items }

async function fetchTopArticles() {
  if (topListCache && Date.now() - topListCache.at < TOP_LIST_CACHE_MS) {
    return topListCache.items;
  }
  // The ranked top-1000 list has more publishing lag than per-article
  // pageviews (it needs every article's data aggregated and sorted first) -
  // "yesterday" 404s more often than not, so step back further if needed.
  let day = latestAvailableDate();
  let lastStatus;
  for (let back = 0; back < 4; back++) {
    const url = `${TOP_LIST_BASE}/en.wikipedia/all-access/${day.getUTCFullYear()}/${pad2(
      day.getUTCMonth() + 1
    )}/${pad2(day.getUTCDate())}`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (res.ok) {
      const data = await res.json();
      const items = (data.items?.[0]?.articles || []).filter(
        (a) => a.article !== "Main_Page" && !NON_ARTICLE.test(a.article)
      );
      topListCache = { at: Date.now(), items };
      return items;
    }
    lastStatus = res.status;
    day = addDaysUTC(day, -1);
  }
  throw new Error(`Top articles API ${lastStatus}`);
}

export async function getTrending(limit = 10) {
  let top;
  try {
    top = await fetchTopArticles();
  } catch {
    return []; // upstream hiccup - ticker just stays empty until next refresh
  }

  // Grab extra candidates in case a few come back unpriced, so we still
  // reliably fill `limit` slots without waiting on every single one.
  const candidates = top.slice(0, Math.max(limit * 2, 20));
  const priced = await Promise.all(
    candidates.map(async ({ article, rank }) => {
      try {
        const p = await getPagePrice("en.wikipedia", article);
        if (p.unpriced) return null;
        return {
          article,
          title: article.replace(/_/g, " "),
          rank,
          price: p.annualPrice,
          changePct: p.changePct,
          latestViews: p.latestViews,
          spark: p.spark || null,
        };
      } catch {
        return null;
      }
    })
  );
  // Promise.all can resolve out of order; keep real-world popularity rank.
  return priced
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

/**
 * Search English Wikipedia article titles. Returns [{ title, article, snippet }].
 * article is the URL-form title (spaces -> underscores) used by the pageviews API.
 */
export async function searchArticles(query) {
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: "0",
      srlimit: "10",
      format: "json",
      origin: "*",
    });
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Search API ${res.status}`);
  const data = await res.json();
  return (data.query?.search || []).map((r) => ({
    title: r.title,
    article: r.title.replace(/ /g, "_"),
    snippet: decodeEntities((r.snippet || "").replace(/<[^>]*>/g, "")),
  }));
}

// The search API returns snippets with HTML entities (&quot;, &#039; ...).
// Decode the common ones so the UI shows real punctuation, not "&quot;".
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
