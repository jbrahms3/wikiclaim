importScripts("lib/wiki.js");

const ALARM_NAME = "wikiclaim-daily-sync";
const STORAGE_KEY = "claims";
const WIKIPICKS_BASE = "https://wikipicks.app";

async function getClaims() {
  const { [STORAGE_KEY]: claims } = await chrome.storage.local.get(STORAGE_KEY);
  return claims || {};
}

async function setClaims(claims) {
  await chrome.storage.local.set({ [STORAGE_KEY]: claims });
}

function totalPointsOf(claims) {
  return Object.values(claims).reduce((sum, c) => sum + (c.totalPoints || 0), 0);
}

/**
 * Backfill a single claim's history/points from the day after its
 * last-fetched date (or its claim date, if never fetched) through the
 * latest date the Pageviews API has data for.
 */
async function syncClaim(claim) {
  const latest = WikiClaimLib.latestAvailableDate();
  let start;
  if (claim.lastFetchedDate) {
    const last = parseDate(claim.lastFetchedDate);
    start = WikiClaimLib.addDaysUTC(last, 1);
  } else {
    start = parseDate(claim.claimedDate);
  }

  if (start > latest) return claim; // already up to date

  const views = await WikiClaimLib.fetchDailyPageviews(
    claim.project,
    claim.article,
    start,
    latest
  );

  claim.history = claim.history || {};
  let cursor = start;
  while (cursor <= latest) {
    const key = WikiClaimLib.formatYYYYMMDD(cursor);
    const dayViews = views.get(key) || 0;
    claim.history[key] = dayViews;
    claim.totalPoints = (claim.totalPoints || 0) + dayViews;
    cursor = WikiClaimLib.addDaysUTC(cursor, 1);
  }
  claim.lastFetchedDate = WikiClaimLib.formatYYYYMMDD(latest);
  return claim;
}

function parseDate(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

async function syncAllClaims() {
  const claims = await getClaims();
  for (const key of Object.keys(claims)) {
    try {
      claims[key] = await syncClaim(claims[key]);
    } catch (err) {
      console.error("WikiClaim sync failed for", key, err);
    }
  }
  await setClaims(claims);
  return claims;
}

async function claimArticle({ project, article, displayTitle, lang }) {
  const claims = await getClaims();
  const key = WikiClaimLib.articleKey(project, article);
  if (!claims[key]) {
    claims[key] = {
      key,
      project,
      article,
      displayTitle,
      lang,
      claimedDate: WikiClaimLib.formatYYYYMMDD(WikiClaimLib.todayUTC()),
      lastFetchedDate: null,
      totalPoints: 0,
      history: {},
    };
  }
  claims[key] = await syncClaim(claims[key]);
  await setClaims(claims);
  return claims[key];
}

async function unclaimArticle(key) {
  const claims = await getClaims();
  delete claims[key];
  await setClaims(claims);
}

/**
 * Real ownership/price/views for the currently-open article, straight from
 * the WikiPicks multiplayer game (a separate system from this extension's
 * own local claim/points tracking above). Public endpoint - no auth needed
 * to read; claiming still requires signing in on wikipicks.app itself.
 */
async function fetchArticleInfo(article) {
  const url = `${WIKIPICKS_BASE}/api/article?article=${encodeURIComponent(article)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let message = `WikiPicks API error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body - keep the generic message */
    }
    throw new Error(message);
  }
  return res.json();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 240, delayInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  syncAllClaims();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncAllClaims();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "CLAIM": {
        const claim = await claimArticle(msg.payload);
        sendResponse({ ok: true, claim });
        break;
      }
      case "UNCLAIM": {
        await unclaimArticle(msg.payload.key);
        sendResponse({ ok: true });
        break;
      }
      case "GET_STATE": {
        const claims = await getClaims();
        sendResponse({ ok: true, claims, totalPoints: totalPointsOf(claims) });
        break;
      }
      case "SYNC_NOW": {
        const claims = await syncAllClaims();
        sendResponse({ ok: true, claims, totalPoints: totalPointsOf(claims) });
        break;
      }
      case "ARTICLE_INFO": {
        try {
          const info = await fetchArticleInfo(msg.payload.article);
          sendResponse({ ok: true, info });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // keep the message channel open for the async response
});
