// Content-script entry. Runs only on sites the user enabled.
// Finds manga images (incl. lazy ones), asks the background to OCR them, draws overlays.
(() => {
  if (globalThis.__ankiMangaLoaded) return;
  globalThis.__ankiMangaLoaded = true;
  const { PageFinder, Overlay } = globalThis.AnkiManga;

  const RETRY_DELAYS = [2000, 4000, 8000];
  const RETRY_LATER = 15000;
  const RETRYABLE = new Set(["warming", "helper_unreachable"]);

  const processed = new Set(); // pageKey of images sent (or in flight)
  const byImg = new Map(); // img -> {key, handle}
  const byPage = new Map(); // pageId -> handle[]
  const waitingPermission = new Set(); // img elements blocked on image-host permission
  let hovered = null; // {pageId, bubbleId}

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: "extension_reloaded" }));
  }

  // --- overlays ---------------------------------------------------------------------
  const overlayOpts = {
    onHover(pageId, bubbleId, text) {
      hovered = { pageId, bubbleId };
      if (!text) send({ type: "am:prioritize", pageId, bubbleId });
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
    const list = byPage.get(page.page_id) || [];
    list.push(handle);
    byPage.set(page.page_id, list);
  }

  // --- processing -------------------------------------------------------------------------
  async function processImage(img, attempt = 0) {
    const url = PageFinder.realImageUrl(img);
    if (!url) return;
    const key = PageFinder.pageKey(url);
    const current = byImg.get(img);
    if (current && current.key === key) return;
    if (processed.has(key) && attempt === 0) return;
    processed.add(key);
    byImg.set(img, { key, handle: null });

    const res = await send({ type: "am:page", imageUrl: url });
    if (res && res.ok) {
      waitingPermission.delete(img);
      await whenDisplayed(img);
      if (byImg.get(img) && byImg.get(img).key === key) showPage(img, key, res.page);
      return;
    }
    const error = res && res.error;
    if (RETRYABLE.has(error)) {
      byImg.delete(img);
      const delay = RETRY_DELAYS[attempt] ?? RETRY_LATER;
      setTimeout(() => processImage(img, attempt + 1), delay);
    } else if (error === "no_image_permission") {
      waitingPermission.add(img);
      processed.delete(key);
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
        const res = await send({
          type: "am:capture",
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          viewportWidth: window.innerWidth,
        });
        if (res && res.ok) {
          const key = `capture:${res.page.page_id}`;
          if (!byImg.get(el) || !byImg.get(el).handle) showPage(el, key, res.page);
        } else if (res && RETRYABLE.has(res.error)) {
          captured.delete(el);
          setTimeout(() => queueCapture(el), RETRY_LATER);
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
      for (const h of byPage.get(msg.pageId) || []) h.setText(msg.bubbleId, msg.text);
    } else if (msg.type === "am:retry") {
      for (const img of [...waitingPermission]) processImage(img);
    }
  });

  scan();
})();
