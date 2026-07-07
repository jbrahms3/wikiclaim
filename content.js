(() => {
  const parsed = WikiClaimLib.parseWikipediaUrl(location.href);
  if (!parsed) return;

  let currentClaim = null;
  let widgetEl = null;

  function fmt(n) {
    return Math.round(n).toLocaleString();
  }

  function render() {
    if (!widgetEl) return;
    const claimed = !!currentClaim;
    widgetEl.classList.toggle("wikiclaim-claimed", claimed);
    widgetEl.innerHTML = "";

    const badge = document.createElement("div");
    badge.className = "wikiclaim-badge";
    badge.textContent = "W";
    widgetEl.appendChild(badge);

    const info = document.createElement("div");
    info.className = "wikiclaim-info";

    const title = document.createElement("div");
    title.className = "wikiclaim-title";
    title.textContent = claimed ? "Claimed" : "Unclaimed article";
    info.appendChild(title);

    if (claimed) {
      const points = document.createElement("div");
      points.className = "wikiclaim-points";
      points.textContent = `${fmt(currentClaim.totalPoints)} pts`;
      info.appendChild(points);
    }
    widgetEl.appendChild(info);

    const btn = document.createElement("button");
    btn.className = "wikiclaim-btn";
    btn.textContent = claimed ? "Unclaim" : "Claim this page";
    btn.disabled = false;
    btn.addEventListener("click", onButtonClick);
    widgetEl.appendChild(btn);
  }

  function setLoading(loading) {
    const btn = widgetEl?.querySelector(".wikiclaim-btn");
    if (btn) {
      btn.disabled = loading;
      btn.textContent = loading ? "..." : btn.textContent;
    }
  }

  async function onButtonClick() {
    setLoading(true);
    try {
      if (currentClaim) {
        await chrome.runtime.sendMessage({
          type: "UNCLAIM",
          payload: { key: currentClaim.key },
        });
        currentClaim = null;
      } else {
        const res = await chrome.runtime.sendMessage({
          type: "CLAIM",
          payload: {
            project: parsed.project,
            article: parsed.article,
            displayTitle: parsed.displayTitle,
            lang: parsed.lang,
          },
        });
        currentClaim = res.claim;
      }
    } finally {
      setLoading(false);
      render();
    }
  }

  function buildWidget() {
    widgetEl = document.createElement("div");
    widgetEl.id = "wikiclaim-widget";
    document.documentElement.appendChild(widgetEl);
    render();
  }

  async function init() {
    buildWidget();
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (state?.ok) {
      const key = WikiClaimLib.articleKey(parsed.project, parsed.article);
      currentClaim = state.claims[key] || null;
      render();
    }
  }

  init();
})();
