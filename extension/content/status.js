// Per-page progress badge ("⏳ 4/11", "✓ 11", "⚠ …") and the panel's per-tab summary.
// The badge text lives in a ::after pseudo-element, so Yomitan never scans it.
(() => {
  const NS = (globalThis.AnkiManga ??= {});

  const ERRORS = {
    extension_reloaded: "extension reloaded — refresh the page",
    no_image_permission: "allow images in the side panel",
    fetch_failed: "can't load this image",
    capture_failed: "allow screenshots in the side panel",
    bad_image: "can't read this image",
    engine_error: "recognition failed — see the side panel",
  };
  const IGNORED = new Set(["not_manga"]);
  const BUSY_ERRORS = {
    models_downloading: "downloading models…",
    models_loading: "loading models…",
  };

  // models: the engine's {receivedBytes, totalBytes, firstRun} sent with a models_* reply (engine/busy.js); absent
  // from an older engine. Short: the badge is small.
  function modelsText(error, models) {
    if (!models) return BUSY_ERRORS[error];
    if (error === "models_downloading" && models.totalBytes > 0) {
      const mb = (b) => Math.round(b / 1e6);
      return `models ${mb(models.receivedBytes)}/${mb(models.totalBytes)} MB`;
    }
    return error === "models_loading" && models.firstRun ? "preparing models…" : "starting OCR…";
  }

  // state: null | {phase: "detecting"} | {phase: "ocr", done, total} | {phase: "error", error, models?}
  function badge(state) {
    if (!state) return null;
    if (state.phase === "detecting") return { text: "⏳ finding bubbles…", kind: "busy" };
    if (state.phase === "ocr") {
      if (state.total === 0) return { text: "✓ no text", kind: "done" };
      if (state.done < state.total) return { text: `⏳ ${state.done}/${state.total}`, kind: "busy" };
      return { text: `✓ ${state.total}`, kind: "done" };
    }
    if (IGNORED.has(state.error)) return null;
    if (BUSY_ERRORS[state.error]) return { text: `⏳ ${modelsText(state.error, state.models)}`, kind: "busy" };
    return { text: `⚠ ${ERRORS[state.error] || state.error || "something went wrong"}`, kind: "error" };
  }

  function summary(states) {
    const s = { ready: 0, working: 0, failed: 0 };
    for (const st of states) {
      const b = badge(st);
      if (!b) continue;
      if (b.kind === "done") s.ready++;
      else if (b.kind === "busy") s.working++;
      else s.failed++;
    }
    return s;
  }

  function summaryText(s) {
    const parts = [];
    if (s.ready) parts.push(`${s.ready} ready`);
    if (s.working) parts.push(`${s.working} recognizing`);
    if (s.failed) parts.push(`${s.failed} failed`);
    return parts.length ? `Pages: ${parts.join(" · ")}` : "No manga pages found yet";
  }

  const STYLE_ID = "am-status-style";
  const FADE_MS = 2500;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .am-badge { position: absolute !important; z-index: 2147483001 !important; pointer-events: none !important;
        margin: 0 !important; padding: 2px 7px !important; border-radius: 10px !important; border: 0 !important;
        font: 600 12px/1.4 system-ui, sans-serif !important; color: #fff !important; background: rgba(40,40,40,.78) !important;
        white-space: nowrap !important; transition: opacity .6s; opacity: 1; transform: translateX(-100%); }
      .am-badge::after { content: attr(data-text); }
      .am-badge[data-kind="done"] { background: rgba(46,125,50,.85) !important; }
      .am-badge[data-kind="error"] { background: rgba(198,40,40,.9) !important; }
      .am-badge.am-faded { opacity: 0; }
    `;
    document.documentElement.appendChild(style);
  }

  // One badge in the top-right corner of a page element.
  function attachBadge(el) {
    injectStyle();
    const node = document.createElement("div");
    node.className = "am-badge";
    node.setAttribute("aria-hidden", "true");
    document.body.appendChild(node);
    let state = null;
    let fadeTimer = null;

    function update() {
      if (!el.isConnected || node.hidden) return;
      const r = el.getBoundingClientRect();
      node.style.left = `${r.right + window.scrollX - 6}px`;
      node.style.top = `${r.top + window.scrollY + 6}px`;
    }

    function set(next) {
      state = next;
      const b = badge(next);
      clearTimeout(fadeTimer);
      node.classList.remove("am-faded");
      node.hidden = !b;
      if (!b) return;
      node.dataset.text = b.text;
      node.dataset.kind = b.kind;
      update();
      if (b.kind === "done") fadeTimer = setTimeout(() => node.classList.add("am-faded"), FADE_MS);
    }

    return { set, update, get state() { return state; }, destroy: () => node.remove() };
  }

  const api = { badge, summary, summaryText, attachBadge };
  NS.Status = api;
  if (typeof module !== "undefined") module.exports = api;
})();
