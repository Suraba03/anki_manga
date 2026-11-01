// Content-script entry. Runs only on sites the user enabled.
// Finds manga images (incl. lazy ones), asks the background to OCR them, draws overlays.
(() => {
  if (globalThis.__ankiMangaLoaded) return;
  globalThis.__ankiMangaLoaded = true;
  const { PageFinder, Overlay, Status } = globalThis.AnkiManga;

  // After the extension is reloaded, the copy that was running in this tab is cut off from it
  // (its layers stay in the DOM but can't reach the helper). Drop those layers; this copy
  // re-creates them from the helper's cache.
  document.querySelectorAll(".am-layer, .am-badge").forEach((n) => n.remove());

  const RETRY_DELAYS = [2000, 4000, 8000];
  const RETRY_LATER = 15000;
  const RETRYABLE = new Set(["warming", "helper_unreachable"]);

  const results = new Map(); // pageKey -> Promise<am:page response> (cached, so re-shown images reuse it)
  const byImg = new Map(); // img -> {key, handle}
  const byPage = new Map(); // pageId -> handle[]
  const waitingPermission = new Set(); // img elements blocked on image-host permission
  let hovered = null; // {pageId, bubbleId}

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: "extension_reloaded" }));
  }

  // --- progress badges + panel summary ----------------------------------------------------
  const badges = new Map(); // page element -> badge

  function setState(el, state) {
    let b = badges.get(el);
    if (!b) {
      if (!state) return;
      b = Status.attachBadge(el);
      badges.set(el, b);
    }
    b.set(state);
    reportSoon();
  }

  function showProgress(handle) {
    setState(handle.img, { phase: "ocr", ...handle.progress() });
  }

  let reportTimer = null;
  function reportSoon() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const states = [];
      for (const [el, b] of badges) {
        if (!el.isConnected) {
          b.destroy();
          badges.delete(el);
        } else states.push(b.state);
      }
      send({ type: "am:status", summary: Status.summary(states) });
    }, 300);
  }

  // --- overlays ---------------------------------------------------------------------
  const overlayOpts = {
    onHover(pageId, bubbleId, text) {
      hovered = { pageId, bubbleId };
      if (!text) {
        send({ type: "am:prioritize", pageId, bubbleId });
        send({ type: "am:watch", pageId });
      }
    },
    onLeave(pageId, bubbleId) {
      if (hovered && hovered.pageId === pageId && hovered.bubbleId === bubbleId) hovered = null;
    },
    onSelect(pageId, bubbleId) {
      send({ type: "am:select", pageId, bubbleId, pageUrl: location.href, pageTitle: document.title });
    },
  };

  function showPage(img, key, page) {
    const prev = byImg.get(img);
    if (prev && prev.handle) prev.handle.destroy();
    const handle = Overlay.attach(img, page, overlayOpts);
    byImg.set(img, { key, handle });
    const list = (byPage.get(page.page_id) || []).filter((h) => h.img.isConnected && h.img !== img);
    list.push(handle);
    byPage.set(page.page_id, list);
    for (const b of page.bubbles) if (b.text) handle.setText(b.id, b.text);
    showProgress(handle);
    if (page.bubbles.some((b) => !b.text)) send({ type: "am:watch", pageId: page.page_id });
  }

  // --- processing -------------------------------------------------------------------------
  async function processImage(img, attempt = 0) {
    const url = PageFinder.realImageUrl(img);
    if (!url) return;
    const key = PageFinder.pageKey(url);
    const current = byImg.get(img);
    if (current && current.key === key && attempt === 0) return;
    byImg.set(img, { key, handle: null });
    if (!results.has(key) || attempt > 0) setState(img, { phase: "detecting" });

    let pending = results.get(key);
    if (!pending || attempt > 0) {
      pending = send({ type: "am:page", imageUrl: url });
      results.set(key, pending);
    }
    const res = await pending;
    if (!(res && res.ok)) results.delete(key);
    if (res && res.ok) {
      waitingPermission.delete(img);
      await whenDisplayed(img);
      if (byImg.get(img) && byImg.get(img).key === key) showPage(img, key, res.page);
      return;
    }
    const error = res && res.error;
    setState(img, { phase: "error", error });
    if (RETRYABLE.has(error)) {
      byImg.delete(img);
      const delay = RETRY_DELAYS[attempt] ?? RETRY_LATER;
      setTimeout(() => processImage(img, attempt + 1), delay);
    } else if (error === "no_image_permission") {
      waitingPermission.add(img);
      byImg.delete(img);
    } else {
      byImg.set(img, { key, handle: null, failed: error });
      if (error !== "not_manga") queueCapture(img);
    }
  }

  // Lazy readers show a placeholder first; draw only once the real image is laid out.
  function whenDisplayed(img) {
    const real = () => img.complete && img.naturalWidth > 1 && !img.src.startsWith("data:");
    if (real()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (real()) {
          img.removeEventListener("load", done);
          resolve();
        }
      };
      img.addEventListener("load", done);
    });
  }

  function candidate(img) {
    if (!PageFinder.realImageUrl(img)) return false;
    if (img.complete && img.naturalWidth > 1 && !img.src.startsWith("data:")) {
      return PageFinder.isMangaImage(img.naturalWidth, img.naturalHeight);
    }
    return true; // lazy placeholder: the background checks the real size after fetching
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && candidate(e.target)) processImage(e.target);
      }
    },
    { rootMargin: "150% 0px" },
  );

  function watch(img) {
    if (img.__amWatched) return;
    img.__amWatched = true;
    io.observe(img);
  }

  function scan(root = document) {
    root.querySelectorAll("img").forEach(watch);
    root.querySelectorAll("canvas").forEach(watchCanvas);
  }

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target.tagName === "IMG") {
        const img = r.target;
        const url = PageFinder.realImageUrl(img);
        const cur = byImg.get(img);
        if (url && cur && cur.key !== PageFinder.pageKey(url)) {
          // one-page readers swap src to the next page
          if (cur.handle) cur.handle.destroy();
          setState(img, null);
          byImg.delete(img);
          io.unobserve(img);
          img.__amWatched = false;
        }
        watch(img);
      }
      for (const n of r.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") watch(n);
        else if (n.tagName === "CANVAS") watchCanvas(n);
        else scan(n);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "data-src", "data-original"],
  });

  // --- screenshot fallback (canvas readers, un-fetchable images) ------------------------------
  const CAPTURE_MIN_VISIBLE = 0.9;
  const captured = new WeakSet();
  const capturePending = new Set();
  const captureBlocked = new Set(); // waiting for the screenshot permission

  function queueCapture(el) {
    if (captured.has(el)) return;
    capturePending.add(el);
    tryCaptures();
  }

  let captureBusy = false;
  async function tryCaptures() {
    if (captureBusy) return;
    captureBusy = true;
    try {
      for (const el of [...capturePending]) {
        if (!el.isConnected) {
          capturePending.delete(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const vp = { w: window.innerWidth, h: window.innerHeight };
        if (PageFinder.visibleFraction(r, vp) < CAPTURE_MIN_VISIBLE) continue;
        capturePending.delete(el);
        captured.add(el);
        setState(el, { phase: "detecting" });
        const res = await send({
          type: "am:capture",
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          viewportWidth: window.innerWidth,
        });
        if (res && res.ok) {
          const key = `capture:${res.page.page_id}`;
          if (!byImg.get(el) || !byImg.get(el).handle) showPage(el, key, res.page);
          continue;
        }
        setState(el, { phase: "error", error: res && res.error });
        if (res && RETRYABLE.has(res.error)) {
          captured.delete(el);
          setTimeout(() => queueCapture(el), RETRY_LATER);
        } else if (res && res.error === "capture_failed") {
          captured.delete(el);
          captureBlocked.add(el);
        }
      }
    } finally {
      captureBusy = false;
    }
  }

  const canvasIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting && PageFinder.isMangaElement(e.target)) queueCapture(e.target);
    },
    { rootMargin: "0px" },
  );
  function watchCanvas(c) {
    if (c.__amWatched) return;
    c.__amWatched = true;
    canvasIo.observe(c);
  }
  window.addEventListener("scroll", () => capturePending.size && tryCaptures(), { passive: true, capture: true });

  // --- keeping overlays aligned -------------------------------------------------------------
  let rafPending = false;
  function updateAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const { handle } of byImg.values()) if (handle) handle.update();
      for (const b of badges.values()) b.update();
    });
  }
  window.addEventListener("resize", updateAll, { passive: true });
  window.addEventListener("scroll", updateAll, { passive: true, capture: true });
  new ResizeObserver(updateAll).observe(document.documentElement);
  document.addEventListener("load", (e) => e.target && e.target.tagName === "IMG" && updateAll(), true);

  // --- keys & messages ------------------------------------------------------------------------
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "KeyV") {
        document.documentElement.classList.toggle("am-show");
        e.preventDefault();
      } else if (e.code === "KeyE" && hovered) {
        overlayOpts.onSelect(hovered.pageId, hovered.bubbleId);
        e.preventDefault();
      }
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "am:bubble-text") {
      for (const h of byPage.get(msg.pageId) || []) {
        h.setText(msg.bubbleId, msg.text);
        showProgress(h);
      }
    } else if (msg.type === "am:retry") {
      for (const img of [...waitingPermission]) processImage(img);
      for (const el of [...captureBlocked]) {
        captureBlocked.delete(el);
        queueCapture(el);
      }
    }
  });

  // The panel asks for a fresh summary when it opens or switches tabs.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "am:status-request") reportSoon();
  });

  scan();
  reportSoon();
})();
