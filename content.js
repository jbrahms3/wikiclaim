(() => {
  const parsed = WikiClaimLib.parseWikipediaUrl(location.href);
  if (!parsed) return;

  const WIKIPICKS_BASE = "https://wikipicks.app";
  // The multiplayer game only tracks English Wikipedia (see server.js's
  // hardcoded project); other language editions get a short explanatory
  // state instead of a bogus/misleading lookup.
  const SUPPORTED = parsed.lang === "en";

  let widgetEl = null;
  let info = null; // last successful /api/article response
  let loadState = "loading"; // "loading" | "loaded" | "error" | "unsupported"
  let errorMessage = "";

  function fmt(n) {
    return Math.round(n).toLocaleString();
  }

  function wikipicksArticleUrl() {
    return `${WIKIPICKS_BASE}/#/article/${encodeURIComponent(parsed.article)}`;
  }

  function openOnWikiPicks() {
    window.open(wikipicksArticleUrl(), "_blank", "noopener");
  }

  function render() {
    if (!widgetEl) return;
    widgetEl.innerHTML = "";

    let state = loadState;
    if (state === "unsupported") {
      // no-op, handled below
    } else if (state === "loaded" && info) {
      state = info.unpriced ? "unpriced" : info.owned ? "owned" : "unowned";
    }
    widgetEl.dataset.state = state;

    const badge = document.createElement("div");
    badge.className = "wikiclaim-badge";
    badge.textContent = "W";
    widgetEl.appendChild(badge);

    const infoEl = document.createElement("div");
    infoEl.className = "wikiclaim-info";

    const title = document.createElement("div");
    title.className = "wikiclaim-title";
    const meta = document.createElement("div");
    meta.className = "wikiclaim-meta";

    let buttonText = null;
    let buttonAction = openOnWikiPicks;

    if (loadState === "unsupported") {
      title.textContent = "English Wikipedia only";
      meta.textContent = "WikiPicks doesn't track this language edition yet.";
    } else if (loadState === "loading") {
      title.textContent = "Loading WikiPicks…";
    } else if (loadState === "error") {
      title.textContent = "Couldn't load WikiPicks data";
      meta.textContent = errorMessage;
      buttonText = "Retry";
      buttonAction = loadInfo;
    } else if (info.unpriced) {
      title.textContent = "Price unavailable";
      meta.textContent = "Wikimedia has no traffic data for this page yet.";
    } else {
      const viewsPart =
        info.latestViews != null ? `${fmt(info.latestViews)} views yesterday` : null;
      if (info.owned) {
        title.textContent = `Owned by ${info.ownerUsername}`;
        if (info.listing) {
          meta.textContent = [`Listed for ${fmt(info.listing.askPrice)} pts`, viewsPart]
            .filter(Boolean)
            .join(" · ");
          buttonText = "Buy on WikiPicks";
        } else {
          meta.textContent = viewsPart || "Not for sale";
          buttonText = "View on WikiPicks";
        }
      } else {
        title.textContent = "Unclaimed";
        meta.textContent = [`${fmt(info.price)} pts to claim`, viewsPart]
          .filter(Boolean)
          .join(" · ");
        buttonText = "Claim on WikiPicks";
      }
    }

    infoEl.appendChild(title);
    if (meta.textContent) infoEl.appendChild(meta);
    widgetEl.appendChild(infoEl);

    if (buttonText) {
      const btn = document.createElement("button");
      btn.className = "wikiclaim-btn";
      btn.textContent = buttonText;
      btn.addEventListener("click", buttonAction);
      widgetEl.appendChild(btn);
    }
  }

  async function loadInfo() {
    loadState = "loading";
    render();
    try {
      const res = await chrome.runtime.sendMessage({
        type: "ARTICLE_INFO",
        payload: { article: parsed.article },
      });
      if (!res?.ok) throw new Error(res?.error || "Unknown error");
      info = res.info;
      loadState = "loaded";
    } catch (err) {
      errorMessage = err.message || String(err);
      loadState = "error";
    }
    render();
  }

  function buildWidget() {
    widgetEl = document.createElement("div");
    widgetEl.id = "wikiclaim-widget";
    document.documentElement.appendChild(widgetEl);
    render();
  }

  function init() {
    buildWidget();
    // Signing in and claiming both happen on wikipicks.app itself (via its
    // existing Clerk sign-in + purchase-confirmation flow) - this widget
    // only ever reads public data, so a claim requiring login never needs
    // any auth handling here.
    if (SUPPORTED) {
      loadInfo();
    } else {
      loadState = "unsupported";
      render();
    }
  }

  init();
})();
