// Talks to public Wikimedia/Wikipedia APIs: article search, pricing (average
// daily pageviews), and per-day view counts used for settlement.
import { store } from "./store.js";

const PAGEVIEWS_BASE =
  "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";

// Wikimedia asks that REST clients send a descriptive User-Agent.
const UA = "WikiClaim/1.0 (https://github.com/local/wikiclaim; game demo)";

const PRICE_WINDOW_DAYS = 30;
const PRICE_CACHE_MS = 6 * 60 * 60 * 1000; // re-price a page at most every 6h

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
 * Returns Map<"YYYYMMDD", views>. A 404 means "no data" -> empty map.
 */
export async function fetchDailyPageviews(project, article, start, end) {
  if (start > end) return new Map();
  const s = `${formatYYYYMMDD(start)}00`;
  const e = `${formatYYYYMMDD(end)}00`;
  const url = `${PAGEVIEWS_BASE}/${project}/all-access/user/${encodeArticle(
    article
  )}/daily/${s}/${e}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (res.status === 404) return new Map();
  if (!res.ok) {
    throw new Error(`Pageviews API ${res.status} for ${project}/${article}`);
  }
  const data = await res.json();
  const out = new Map();
  for (const item of data.items || []) {
    const day = item.timestamp.slice(0, 8);
    out.set(day, (out.get(day) || 0) + item.views);
  }
  return out;
}

/**
 * Current "market price" of an article = average daily views over the last
 * PRICE_WINDOW_DAYS available days. Cached for a few hours. Minimum price 1.
 */
export async function getPagePrice(project, article, { force = false } = {}) {
  const key = pageKey(project, article);
  const cached = await store.getPageCache(key);
  if (!force && cached && Date.now() - cached.updatedAt < PRICE_CACHE_MS) {
    return cached;
  }

  const end = latestAvailableDate();
  const start = addDaysUTC(end, -(PRICE_WINDOW_DAYS - 1));
  const views = await fetchDailyPageviews(project, article, start, end);

  let sum = 0;
  for (const v of views.values()) sum += v;
  const avg = Math.max(1, Math.round(sum / PRICE_WINDOW_DAYS));
  const latestViews = views.get(formatYYYYMMDD(end)) ?? avg;
  // "Change" = today vs. the 30-day average it's priced at, like a stock's
  // move relative to a moving average. Bounded away from #DIV/0 by the avg floor.
  const changePct = ((latestViews - avg) / avg) * 100;

  const entry = {
    key,
    project,
    article,
    avgViews: avg,
    latestViews,
    changePct: Math.round(changePct * 10) / 10,
    windowDays: PRICE_WINDOW_DAYS,
    updatedAt: Date.now(),
  };
  await store.setPageCache(entry);
  return entry;
}

/**
 * Daily view counts for the last `days` available days, oldest first —
 * chart-ready. Does not use the price cache (short-lived, chart-specific).
 */
export async function getArticleHistory(project, article, days = 30) {
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
  return out;
}

// A small curated set of high-traffic articles to show as a "market ticker",
// the way a finance dashboard shows a strip of well-known stock symbols.
export const TRENDING_ARTICLES = [
  "Cat",
  "Dog",
  "Artificial_intelligence",
  "ChatGPT",
  "Bitcoin",
  "Elon_Musk",
  "Taylor_Swift",
  "Elizabeth_II",
];

export async function getTrending() {
  const items = await Promise.all(
    TRENDING_ARTICLES.map(async (article) => {
      try {
        const p = await getPagePrice("en.wikipedia", article);
        return {
          article,
          title: article.replace(/_/g, " "),
          price: p.avgViews,
          changePct: p.changePct,
        };
      } catch {
        return null;
      }
    })
  );
  return items.filter(Boolean);
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
