// Content-script entry. Runs only on sites the user enabled.
// Finds manga images (incl. lazy ones), asks the background to OCR them, draws overlays.
(() => {
  if (globalThis.__ankiMangaLoaded) return;
  globalThis.__ankiMangaLoaded = true;
  const { PageFinder, Overlay, Status } = globalThis.AnkiManga;

  // After the extension is reloaded, the copy that was running in this tab is cut off from it
  // (its layers stay in the DOM but can't reach the extension). Drop those layers; this copy
  // re-creates them from the engine's cache.
  document.querySelectorAll(".am-layer, .am-badge").forEach((n) => n.remove());

  const RETRY_DELAYS = [2000, 4000, 8000];
  const RETRY_LATER = 15000;
  const RETRYABLE = new Set(["models_downloading", "models_loading"]);
  // engine_error (a failed model download or start): the engine restarts itself on the next request, so try again
  // a few times with a growing pause, then leave the failed badge until the worker says the engine is ready (am:retry).
  const ENGINE_ERROR_DELAYS = [5000, 15000, 60000];
  // Only an image the engine could not read is worth a screenshot (which needs the <all_urls> permission).
  const UNREADABLE = new Set(["fetch_failed", "bad_image"]);

  const results = new Map(); // pageKey -> Promise<am:page response> (cached, so re-shown images reuse it)
  const byImg = new Map(); // img -> {key, handle}
  const byPage = new Map(); // pageId -> handle[]
  const waitingPermission = new Set(); // img elements blocked on image-host permission
  const engineFailures = new Map(); // img -> engine_error count since the last success
  const engineFailed = new Set(); // img elements that gave up after engine_error
  const retrying = new Set(); // img elements with a retry timer pending
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
  const MAX_DATA_URL = 48 * 1024 * 1024; // the worker's limit; Chrome's 64 MB per message also has to hold the envelope
  const corsBlocked = new Set(); // hosts whose images this tab could not fetch (no CORS): one console error per host
  const fetchThrows = new Map(); // host -> fetches that threw since the last success (one network error is no CORS)
  const CORS_STRIKES = 2;
  const FETCH_RETRY_MS = 500;

  function toDataUrl(blob) {
    if ((blob.size * 4) / 3 > MAX_DATA_URL) return Promise.reject(new Error("too big")); // base64 is 4/3 of the bytes
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // The image bytes as the page gets them: this script runs on the page's origin, so a fetch carries the page's Referer
  // (and, same-origin, its cookies). Else a copy of what the <img> shows. null when neither works.
  async function pageBytes(img, url) {
    let dataUrl = null;
    const u = new URL(url);
    const direct = u.protocol === "blob:" || u.origin === location.origin;
    if ((u.protocol === "blob:" || u.protocol === "http:" || u.protocol === "https:") && (direct || !corsBlocked.has(u.host))) {
      // A fetch that throws (TypeError: network or CORS) is tried once more after a pause: a burst of lazy images
      // loading at once drops a few connections. Not on an HTTP error, which says nothing about the host or the network.
      let resp = await fetch(url).catch(() => null);
      if (!resp) {
        await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_MS));
        resp = await fetch(url).catch(() => null);
      }
      if (resp) fetchThrows.delete(u.host);
      else {
        // Failed twice. Two such images in a row block the host (a real CORS failure costs a console error per try).
        const strikes = (fetchThrows.get(u.host) || 0) + 1;
        fetchThrows.set(u.host, strikes);
        if (!direct && strikes >= CORS_STRIKES) corsBlocked.add(u.host);
      }
      try {
        if (resp && resp.ok) dataUrl = await toDataUrl(await resp.blob());
      } catch {
        /* unreadable or too big: the next source */
      }
    }
    if (!dataUrl && isShown(img) && shows(img, url)) {
      // servers that refuse a second load, one-time tokens, blob: images whose fetch failed; a tainted canvas throws
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob) dataUrl = await toDataUrl(blob);
      } catch {
        /* cross-origin pixels: the worker fetches it */
      }
    }
    return dataUrl;
  }

  // The <img> currently displays url (not a lazy placeholder, nor the previous page of a reused element).
  function shows(img, url) {
    try {
      return PageFinder.pageKey(new URL(img.currentSrc || img.src, document.baseURI).href) === PageFinder.pageKey(url);
    } catch {
      return false;
    }
  }

  async function loadPage(img, url) {
    const dataUrl = await pageBytes(img, url);
    if (dataUrl) return send({ type: "am:page", imageUrl: url, dataUrl });
    if (url.startsWith("blob:")) return { ok: false, error: "fetch_failed" }; // the worker can't open it
    return send({ type: "am:page", imageUrl: url });
  }

  async function processImage(img, attempt = 0) {
    const url = PageFinder.realImageUrl(img);
    if (!url) return;
    const key = PageFinder.pageKey(url);
    const current = byImg.get(img);
    if (current && current.key === key && attempt === 0) return;
    byImg.set(img, { key, handle: null });
    // No badge until the image is laid out: a lazy placeholder may turn out to be an icon.
    if ((!results.has(key) || attempt > 0) && isShown(img)) setState(img, { phase: "detecting" });

    let pending = results.get(key);
    if (!pending || attempt > 0) {
      pending = loadPage(img, url);
      results.set(key, pending);
    }
    const res = await pending;
    if (!(res && res.ok)) results.delete(key);
    if (res && res.ok) {
      waitingPermission.delete(img);
      engineFailures.delete(img);
      await whenLaidOut(img); // the engine read the real bytes: it does not matter which pixels the <img> shows now
      if (byImg.get(img) && byImg.get(img).key === key) showPage(img, key, res.page);
      return;
    }
    // An error of an image whose size is not known yet waits for it: a small one is no page, so no badge, no host
    // request, no screenshot.
    await whenSized(img);
    if (!byImg.get(img) || byImg.get(img).key !== key) return; // swapped to another page meanwhile
    if (!PageFinder.isMangaElement(img)) {
      byImg.set(img, { key, handle: null, failed: "not_manga" });
      setState(img, null);
      return;
    }
    const error = res && res.error;
    setState(img, { phase: "error", error });
    if (RETRYABLE.has(error)) {
      byImg.delete(img);
      retryLater(img, attempt, RETRY_DELAYS[attempt] ?? RETRY_LATER);
    } else if (error === "engine_error") {
      const failures = engineFailures.get(img) || 0;
      engineFailures.set(img, failures + 1);
      if (failures < ENGINE_ERROR_DELAYS.length) {
        byImg.delete(img);
        retryLater(img, attempt, ENGINE_ERROR_DELAYS[failures]);
      } else {
        byImg.set(img, { key, handle: null, failed: error });
        engineFailed.add(img);
      }
    } else if (error === "no_image_permission") {
      waitingPermission.add(img);
      byImg.delete(img);
      send({ type: "am:missing-host", host: res.host }); // the panel lists the hosts to allow
    } else {
      byImg.set(img, { key, handle: null, failed: error });
      if (UNREADABLE.has(error)) queueCapture(img);
    }
  }

  function retryLater(img, attempt, delay) {
    retrying.add(img);
    setTimeout(() => {
      retrying.delete(img);
      processImage(img, attempt + 1);
    }, delay);
  }

  // The <img> shows its real image (not a lazy placeholder, not the previous page) and the size is known.
  function isShown(img) {
    const url = PageFinder.realImageUrl(img);
    return !!url && img.complete && img.naturalWidth > 1 && !img.src.startsWith("data:") && shows(img, url);
  }

  // The <img> has pixels (maybe a placeholder or a resized copy), whichever URL they came from.
  function isLaidOut(img) {
    return img.complete && img.naturalWidth > 1 && !img.src.startsWith("data:");
  }

  // Lazy readers show a placeholder first. One promise per image and condition, so retries don't stack listeners;
  // forgotten when the reader swaps the src.
  const SIZE_SETTLE_MS = 3000;
  const laidOutWaits = new WeakMap();
  function whenIs(img, ready, memo) {
    if (ready(img)) return Promise.resolve();
    if (!memo.has(img)) {
      memo.set(
        img,
        new Promise((resolve) => {
          const done = () => {
            if (ready(img)) {
              img.removeEventListener("load", done);
              memo.delete(img);
              resolve();
            }
          };
          img.addEventListener("load", done);
        }),
      );
    }
    return memo.get(img);
  }
  const whenLaidOut = (img) => whenIs(img, isLaidOut, laidOutWaits);

  // The size to judge by: of the real image. An <img> that keeps showing another URL for good (a resized src with the
  // original in data-src) never gets there, so after its next load event or 3 s the laid-out size is used.
  async function whenSized(img) {
    if (isShown(img)) return;
    await whenLaidOut(img);
    if (isShown(img)) return;
    await new Promise((resolve) => {
      const done = () => {
        img.removeEventListener("load", done);
        resolve();
      };
      img.addEventListener("load", done);
      setTimeout(done, SIZE_SETTLE_MS);
    });
  }

  function candidate(img) {
    if (!PageFinder.realImageUrl(img)) return false;
    if (isShown(img)) return PageFinder.isMangaImage(img.naturalWidth, img.naturalHeight);
    return true; // lazy placeholder: the background checks the real size after fetching
  }

  // Prefetch starts a page well before it scrolls into view; on-demand (slow machines) only
  // starts pages that are at least half visible.
  const IO_OPTIONS = {
    prefetch: { rootMargin: "150% 0px" },
    "on-demand": { rootMargin: "0px", threshold: [0.1, 0.2, 0.3, 0.4, 0.5] },
  };
  const imgs = new Set(); // watched <img> elements, to re-observe when the mode changes
  let perfMode = "prefetch";
  let io = makeObserver(perfMode);

  // isIntersecting turns true at one pixel of overlap, so on-demand checks the share itself: half of the page, or (a
  // tall strip can never be half visible) half of the viewport.
  function startsHere(e, mode) {
    if (mode !== "on-demand") return true;
    return e.intersectionRatio >= 0.5 || e.intersectionRect.height >= window.innerHeight * 0.5;
  }

  function makeObserver(mode) {
    return new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && startsHere(e, mode) && candidate(e.target)) processImage(e.target);
        }
      },
      IO_OPTIONS[mode],
    );
  }

  function applyMode(mode) {
    if (mode === perfMode) return;
    perfMode = mode;
    io.disconnect();
    io = makeObserver(mode);
    for (const img of imgs) if (img.isConnected) io.observe(img);
  }

  // The worker decides the mode (it holds the settings, incl. the API key, which a content script must never read)
  // and pushes a changed mode as am:perf-mode.
  const MODES = new Set(["prefetch", "on-demand"]);
  send({ type: "am:perf-mode" }).then((r) => r && MODES.has(r.mode) && applyMode(r.mode));

  function watch(img) {
    if (img.__amWatched) return;
    img.__amWatched = true;
    imgs.add(img);
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
          imgs.delete(img);
          laidOutWaits.delete(img);
          img.__amWatched = false;
        } else if (url && !cur && img.__amWatched && !waitingPermission.has(img) && !retrying.has(img)) {
          // src set after the observer's first report (blob: images a reader builds later): observe again for a new one
          io.unobserve(img);
          io.observe(img);
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
  const SLICE_MIN_HEIGHT = 400; // CSS px
  const SCROLL_IDLE_MS = 400; // a slice is taken once scrolling has stopped, else the rows would be wrong
  const captured = new WeakSet();
  const capturePending = new Set();
  const captureBlocked = new Set(); // waiting for the screenshot permission
  const sliceCovered = new WeakMap(); // tall element -> [from, to] fractions of its height already captured
  const sliceError = new WeakMap(); // tall element -> stand-in carrying the error badge of its last slice
  const taken = new Map(); // capture id -> {el, top, moved}: the element's top when the request left, and whether it moved by the shot
  let captureId = 0;
  let scrollTimer = null;
  let screenshots = null; // the worker's answer to the permission probe: null (not asked) | "ok" | "blocked"
  let scrolling = false;

  function dropBadge(el) {
    const b = badges.get(el);
    if (!b) return;
    b.destroy();
    badges.delete(el);
    reportSoon();
  }

  // Waits for the screenshot permission (re-queued on am:retry).
  function blockCapture(el) {
    capturePending.delete(el);
    captured.delete(el);
    captureBlocked.add(el);
    setState(el, { phase: "error", error: "capture_failed" });
  }

  function queueCapture(el) {
    if (captured.has(el)) return;
    if (screenshots === "blocked") return blockCapture(el);
    capturePending.add(el);
    tryCaptures();
  }

  // What the overlay and badge of one slice of a tall element use in place of an element: they only read these two.
  function sliceTarget(el, s) {
    return {
      get isConnected() {
        return el.isConnected;
      },
      getBoundingClientRect() {
        const r = el.getBoundingClientRect();
        const left = r.left + s.xFrom * r.width;
        const top = r.top + s.from * r.height;
        const width = (s.xTo - s.xFrom) * r.width;
        const height = (s.to - s.from) * r.height;
        return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
      },
    };
  }

  let captureBusy = false;
  let captureAgain = false;
  async function tryCaptures() {
    if (captureBusy) {
      captureAgain = true;
      return;
    }
    captureBusy = true;
    try {
      if (!capturePending.size) return;
      if (!screenshots) {
        // Ask for the permission before the first screenshot, so the user hears about it while the page is not in view too.
        const probe = await send({ type: "am:capture", probe: true });
        if (probe && probe.ok) screenshots = "ok";
        else if (probe && probe.error === "capture_failed") {
          screenshots = "blocked";
          for (const el of [...capturePending]) blockCapture(el);
          return;
        }
      }
      for (const el of [...capturePending]) {
        if (!el.isConnected) {
          capturePending.delete(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const vp = { w: window.innerWidth, h: window.innerHeight };
        if (sliceCovered.has(el)) {
          if (r.height > CAPTURE_MIN_VISIBLE * vp.h && !scrolling) await captureSliceOf(el, r, vp);
        } else if (PageFinder.visibleFraction(r, vp) >= CAPTURE_MIN_VISIBLE) await captureWhole(el, r);
        else if (r.height > CAPTURE_MIN_VISIBLE * vp.h && !scrolling) await captureSliceOf(el, r, vp);
        // else a short element that is only partly visible: wait for the whole page
      }
    } finally {
      captureBusy = false;
      if (captureAgain) {
        captureAgain = false;
        tryCaptures();
      }
    }
  }

  async function captureWhole(el, r) {
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
      return;
    }
    setState(el, { phase: "error", error: res && res.error });
    if (res && RETRYABLE.has(res.error)) {
      captured.delete(el);
      setTimeout(() => queueCapture(el), RETRY_LATER);
    } else if (res && res.error === "capture_failed") blockCapture(el);
  }

  // A page taller than the window never gets 90 % visible: capture what is visible and not yet captured.
  async function captureSliceOf(el, r, vp) {
    const covered = sliceCovered.get(el) || [];
    const s = PageFinder.captureSlice(r, vp, covered, SLICE_MIN_HEIGHT);
    if (!s) return;
    if (sliceError.has(el)) dropBadge(sliceError.get(el));
    sliceError.delete(el);
    const target = sliceTarget(el, s);
    setState(target, { phase: "detecting" });
    const id = ++captureId;
    taken.set(id, { el, top: r.top, moved: false });
    const res = await send({
      type: "am:capture",
      id,
      rect: { x: s.x, y: s.y, width: s.width, height: s.height },
      viewportWidth: vp.w,
    });
    const shot = taken.get(id);
    taken.delete(id);
    if (res && res.ok) {
      // Only a move before the screenshot was taken makes the rows wrong (a later one the overlay follows). No
      // "taken" message (old worker) means no check.
      if (!el.isConnected || shot.moved) {
        dropBadge(target);
        setTimeout(tryCaptures, SCROLL_IDLE_MS); // a layout shift without a scroll still retriggers
        return;
      }
      covered.push([s.from, s.to]);
      sliceCovered.set(el, covered);
      dropBadge(el); // the element's own "allow screenshots" / "can't load" badge: its slices work
      showPage(target, `capture:${res.page.page_id}`, res.page);
      return;
    }
    if (res && res.error === "capture_failed") {
      dropBadge(target);
      blockCapture(el);
      return;
    }
    setState(target, { phase: "error", error: res && res.error });
    sliceError.set(el, target);
    if (res && RETRYABLE.has(res.error)) setTimeout(tryCaptures, RETRY_LATER);
    else {
      covered.push([s.from, s.to]); // any other error is final, as for a whole page
      sliceCovered.set(el, covered);
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
  window.addEventListener(
    "scroll",
    () => {
      scrolling = true;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrolling = false;
        if (capturePending.size) tryCaptures();
      }, SCROLL_IDLE_MS);
      if (capturePending.size) tryCaptures();
    },
    { passive: true, capture: true },
  );

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
    } else if (msg.type === "am:perf-mode") {
      if (MODES.has(msg.mode)) applyMode(msg.mode);
    } else if (msg.type === "am:capture-taken") {
      const shot = taken.get(msg.id);
      if (shot) shot.moved = Math.abs(shot.el.getBoundingClientRect().top - shot.top) > 2;
    } else if (msg.type === "am:retry") {
      for (const img of [...engineFailed]) {
        engineFailed.delete(img);
        engineFailures.delete(img);
        byImg.delete(img);
        processImage(img);
      }
      for (const img of [...waitingPermission]) processImage(img);
      screenshots = null; // ask for the permission again
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
