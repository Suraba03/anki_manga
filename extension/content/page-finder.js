// Pure helpers: which elements are manga pages, and their real image URL.
(() => {
  const MIN_SIDE = 400;
  const MIN_LONG_SIDE = 600;

  function isMangaImage(w, h) {
    return Math.min(w, h) >= MIN_SIDE && Math.max(w, h) >= MIN_LONG_SIDE;
  }

  function realImageUrl(img, base = globalThis.document ? document.baseURI : undefined) {
    const candidates = [img.dataset && img.dataset.src, img.getAttribute("data-original"), img.currentSrc, img.src];
    for (const url of candidates) {
      if (!url || url.startsWith("data:")) continue;
      try {
        return new URL(url, base).href;
      } catch {
        /* unparseable attribute: try the next candidate */
      }
    }
    return null;
  }

  function pageKey(url) {
    const hash = url.indexOf("#");
    return hash >= 0 ? url.slice(0, hash) : url;
  }

  function isMangaElement(el) {
    if (el.tagName === "CANVAS") return isMangaImage(el.width, el.height);
    if (el.tagName === "IMG") return isMangaImage(el.naturalWidth, el.naturalHeight);
    return false;
  }

  // Share of the element's rect inside the viewport (0..1).
  function visibleFraction(rect, viewport) {
    const w = Math.max(0, Math.min(rect.left + rect.width, viewport.w) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.top + rect.height, viewport.h) - Math.max(rect.top, 0));
    const area = rect.width * rect.height;
    return area > 0 ? (w * h) / area : 0;
  }

  // The part of a tall element to screenshot now: the visible rect, vertically the largest part not in `covered`
  // (sorted-or-not [from, to] fractions of the element height). null when nothing visible is left, or it is under
  // minHeight CSS px. x/y/width/height are viewport CSS px; from/to and xFrom/xTo are fractions of the element.
  function captureSlice(rect, viewport, covered, minHeight) {
    const x0 = Math.max(rect.left, 0);
    const x1 = Math.min(rect.left + rect.width, viewport.w);
    const y0 = Math.max(rect.top, 0);
    const y1 = Math.min(rect.top + rect.height, viewport.h);
    if (x1 <= x0 || y1 <= y0 || rect.height <= 0 || rect.width <= 0) return null;
    let free = [[(y0 - rect.top) / rect.height, (y1 - rect.top) / rect.height]];
    for (const [cf, ct] of covered) {
      free = free.flatMap(([f, t]) => (ct <= f || cf >= t ? [[f, t]] : [[f, Math.min(t, cf)], [Math.max(f, ct), t]].filter(([a, b]) => b > a)));
    }
    let best = null;
    for (const iv of free) if (!best || iv[1] - iv[0] > best[1] - best[0]) best = iv;
    if (!best || (best[1] - best[0]) * rect.height < minHeight) return null;
    const [from, to] = best;
    return {
      x: x0,
      y: rect.top + from * rect.height,
      width: x1 - x0,
      height: (to - from) * rect.height,
      from,
      to,
      xFrom: (x0 - rect.left) / rect.width,
      xTo: (x1 - rect.left) / rect.width,
    };
  }

  const PageFinder = { isMangaImage, isMangaElement, visibleFraction, captureSlice, realImageUrl, pageKey, MIN_SIDE, MIN_LONG_SIDE };
  if (typeof module !== "undefined") module.exports = PageFinder;
  else (globalThis.AnkiManga ??= {}).PageFinder = PageFinder;
})();
