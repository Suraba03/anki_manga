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

  const PageFinder = { isMangaImage, isMangaElement, visibleFraction, realImageUrl, pageKey, MIN_SIDE, MIN_LONG_SIDE };
  if (typeof module !== "undefined") module.exports = PageFinder;
  else (globalThis.AnkiManga ??= {}).PageFinder = PageFinder;
})();
