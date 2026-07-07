(() => {
  const totalScoreEl = document.getElementById("total-score");
  const scoreSubEl = document.getElementById("score-sub");
  const listEl = document.getElementById("claims-list");
  const emptyEl = document.getElementById("empty-state");
  const refreshBtn = document.getElementById("refresh-btn");
  const statusEl = document.getElementById("status-text");

  function fmt(n) {
    return Math.round(n || 0).toLocaleString();
  }

  function latestDayViews(claim) {
    const dates = Object.keys(claim.history || {}).sort();
    if (!dates.length) return null;
    const last = dates[dates.length - 1];
    return { date: last, views: claim.history[last] };
  }

  function wikiUrl(claim) {
    return `https://${claim.lang}.wikipedia.org/wiki/${claim.article}`;
  }

  function render(claims, totalPoints) {
    const list = Object.values(claims).sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));

    totalScoreEl.textContent = fmt(totalPoints);
    scoreSubEl.textContent = `from ${list.length} claimed article${list.length === 1 ? "" : "s"}`;

    listEl.innerHTML = "";
    emptyEl.hidden = list.length > 0;

    list.forEach((claim, i) => {
      const li = document.createElement("li");
      li.className = "claim-item";

      const rank = document.createElement("div");
      rank.className = "claim-rank";
      rank.textContent = `${i + 1}`;
      li.appendChild(rank);

      const main = document.createElement("div");
      main.className = "claim-main";

      const title = document.createElement("div");
      title.className = "claim-title";
      const a = document.createElement("a");
      a.href = wikiUrl(claim);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = claim.displayTitle;
      title.appendChild(a);
      main.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "claim-meta";
      const latest = latestDayViews(claim);
      meta.textContent = latest
        ? `${claim.lang} · ${fmt(latest.views)} views last day`
        : `${claim.lang} · syncing...`;
      main.appendChild(meta);

      li.appendChild(main);

      const points = document.createElement("div");
      points.className = "claim-points";
      points.textContent = fmt(claim.totalPoints);
      li.appendChild(points);

      const remove = document.createElement("button");
      remove.className = "claim-remove";
      remove.textContent = "✕";
      remove.title = "Unclaim";
      remove.addEventListener("click", () => onUnclaim(claim.key));
      li.appendChild(remove);

      listEl.appendChild(li);
    });
  }

  async function loadState() {
    const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (res?.ok) render(res.claims, res.totalPoints);
  }

  async function onUnclaim(key) {
    await chrome.runtime.sendMessage({ type: "UNCLAIM", payload: { key } });
    loadState();
  }

  async function onRefresh() {
    refreshBtn.classList.add("spinning");
    statusEl.textContent = "Syncing pageviews...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
      if (res?.ok) render(res.claims, res.totalPoints);
      statusEl.textContent = `Synced ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      statusEl.textContent = "Sync failed - try again";
    } finally {
      refreshBtn.classList.remove("spinning");
    }
  }

  refreshBtn.addEventListener("click", onRefresh);

  loadState().then(onRefresh);
})();
