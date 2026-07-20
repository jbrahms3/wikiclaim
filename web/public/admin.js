(() => {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
  const KEY_STORAGE = "wikipicks_admin_key";

  const keyCard = $("#key-card");
  const reviewView = $("#review-view");
  const keyInput = $("#key-input");
  const keyError = $("#key-error");

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function getKey() {
    return sessionStorage.getItem(KEY_STORAGE) || "";
  }

  async function adminFetch(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), "X-Admin-Key": getKey() },
    });
    if (res.status === 401) {
      sessionStorage.removeItem(KEY_STORAGE);
      throw new Error("Admin key rejected - it may be wrong, or ADMIN_KEY isn't set on the server.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function viewsStripHtml(recentViews) {
    if (!recentViews || !recentViews.length) return "";
    const max = Math.max(1, ...recentViews.map((d) => d.views));
    return `<div class="views-strip">${recentViews
      .map((d, i) => {
        const h = Math.max(2, Math.round((d.views / max) * 28));
        const isLast = i === recentViews.length - 1;
        return `<div class="bar${isLast ? " today" : ""}" style="height:${h}px" title="${escapeHtml(d.date)}: ${fmt(d.views)} views"></div>`;
      })
      .join("")}</div>`;
  }

  function increaseText(h) {
    if (h.dayBeforeViews == null || h.latestViews == null) return "Not enough history";
    const pctText = h.increasePct == null ? "" : ` (${h.increasePct >= 0 ? "+" : ""}${h.increasePct}%)`;
    const sign = h.increaseAmount >= 0 ? "+" : "";
    return `${fmt(h.dayBeforeViews)} → ${fmt(h.latestViews)} (${sign}${fmt(h.increaseAmount)}${pctText})`;
  }

  function rowHtml(h) {
    return `
      <tr data-id="${escapeHtml(h.holdingId)}">
        <td>${escapeHtml(h.username)}</td>
        <td><a href="${escapeHtml(h.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.displayTitle)}</a></td>
        <td class="num">${fmt(h.escrowedEarned)}</td>
        <td class="num">${h.escrowStreakDays}d</td>
        <td>
          ${viewsStripHtml(h.recentViews)}
          <div class="views-stats">
            <div>Day before → latest: <strong>${increaseText(h)}</strong></div>
            <div>7d avg: ${h.weekAvgViews == null ? "—" : fmt(h.weekAvgViews)} · 30d avg: ${h.monthAvgViews == null ? "—" : fmt(h.monthAvgViews)}</div>
          </div>
        </td>
        <td class="row-actions">
          <button class="btn-primary btn-sm" data-action="release">Release</button>
          <button class="btn-danger btn-sm" data-action="forfeit">Forfeit</button>
        </td>
      </tr>`;
  }

  async function loadFlagged() {
    const tbody = $("#escrow-table tbody");
    tbody.innerHTML = `<tr><td colspan="6" class="escrow-empty">Loading…</td></tr>`;
    try {
      const { holdings } = await adminFetch("/api/admin/escrow");
      $("#escrow-empty").hidden = holdings.length > 0;
      $("#escrow-table").hidden = holdings.length === 0;
      tbody.innerHTML = holdings.map(rowHtml).join("");
    } catch (err) {
      tbody.innerHTML = "";
      if (err.message.includes("rejected")) {
        showKeyPrompt(err.message);
        return;
      }
      $("#escrow-empty").hidden = false;
      $("#escrow-table").hidden = true;
      $("#escrow-empty").textContent = err.message;
    }
  }

  $("#escrow-table").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr.dataset.id;
    const action = btn.dataset.action;
    if (action === "forfeit" && !confirm("Forfeit this holding's held earnings? This cannot be undone.")) return;
    btn.disabled = true;
    try {
      await adminFetch(`/api/admin/escrow/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      tr.remove();
      const remaining = $("#escrow-table tbody tr").length;
      $("#escrow-empty").hidden = remaining > 0;
      $("#escrow-table").hidden = remaining === 0;
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  $("#refresh-btn").addEventListener("click", loadFlagged);
  $("#signout-btn").addEventListener("click", () => {
    sessionStorage.removeItem(KEY_STORAGE);
    showKeyPrompt();
  });

  function showKeyPrompt(errorMsg) {
    reviewView.hidden = true;
    keyCard.hidden = false;
    keyError.hidden = !errorMsg;
    keyError.textContent = errorMsg || "";
    keyInput.value = "";
    keyInput.focus();
  }

  function showReview() {
    keyCard.hidden = true;
    reviewView.hidden = false;
    loadFlagged();
  }

  $("#key-submit").addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!key) return;
    sessionStorage.setItem(KEY_STORAGE, key);
    showReview();
  });
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#key-submit").click();
  });

  if (getKey()) showReview();
  else showKeyPrompt();
})();
