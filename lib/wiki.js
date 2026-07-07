// Shared helpers for talking to Wikipedia URLs and the Wikimedia Pageviews API.
// Loaded as a plain script in both the content script and the service worker
// (via importScripts) and the popup (via <script>), so it must not use
// import/export syntax — everything hangs off the WikiClaimLib global.

const WikiClaimLib = (() => {
  const PAGEVIEWS_BASE =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";

  function parseWikipediaUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const hostMatch = url.hostname.match(/^([a-z0-9-]+)\.wikipedia\.org$/i);
    if (!hostMatch) return null;
    const lang = hostMatch[1].toLowerCase();
    if (lang === "www" || lang === "wikimedia") return null;

    const pathMatch = url.pathname.match(/^\/wiki\/([^?#]+)/);
    if (!pathMatch) return null;

    const rawTitle = pathMatch[1];
    if (rawTitle.includes(":")) {
      // Skip Special:, Talk:, File:, Category:, etc. - only plain articles count.
      const prefix = rawTitle.split(":")[0];
      if (/^(special|talk|file|category|template|wikipedia|help|portal|user|draft|module)$/i.test(prefix)) {
        return null;
      }
    }

    const article = rawTitle; // keep underscores + percent-encoding as-is for the API
    const displayTitle = decodeURIComponent(rawTitle).replace(/_/g, " ");
    const project = `${lang}.wikipedia`;

    return { lang, project, article, displayTitle };
  }

  function articleKey(project, article) {
    return `${project}::${article}`;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatYYYYMMDD(date) {
    return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
  }

  function todayUTC() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function addDaysUTC(date, days) {
    return new Date(date.getTime() + days * 86400000);
  }

  // The pageviews dataset typically lags 1-2 days behind real time.
  function latestAvailableDate() {
    return addDaysUTC(todayUTC(), -2);
  }

  /**
   * Fetch daily view counts for [startDate, endDate] inclusive (UTC day granularity).
   * Returns a Map of "YYYYMMDD" -> views. Missing/zero-view days are simply absent.
   */
  async function fetchDailyPageviews(project, article, startDate, endDate) {
    if (startDate > endDate) return new Map();
    const start = `${formatYYYYMMDD(startDate)}00`;
    const end = `${formatYYYYMMDD(endDate)}00`;
    const url = `${PAGEVIEWS_BASE}/${project}/all-access/user/${article}/daily/${start}/${end}`;

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) {
      return new Map(); // no data for this range (e.g. brand-new or zero-traffic article)
    }
    if (!res.ok) {
      throw new Error(`Pageviews API error ${res.status} for ${project}/${article}`);
    }
    const data = await res.json();
    const out = new Map();
    for (const item of data.items || []) {
      const dateKey = item.timestamp.slice(0, 8); // YYYYMMDD
      out.set(dateKey, (out.get(dateKey) || 0) + item.views);
    }
    return out;
  }

  return {
    parseWikipediaUrl,
    articleKey,
    formatYYYYMMDD,
    todayUTC,
    addDaysUTC,
    latestAvailableDate,
    fetchDailyPageviews,
  };
})();

if (typeof self !== "undefined") self.WikiClaimLib = WikiClaimLib;
