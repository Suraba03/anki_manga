// Pure helpers: which elements are manga pages, and their real image URL.
(() => {
  const MIN_SIDE = 400;
  const MIN_LONG_SIDE = 600;

  function isMangaImage(w, h) {
    return Math.min(w, h) >= MIN_SIDE && Math.max(w, h) >= MIN_LONG_SIDE;
  }

  function realImageUrl(img) {
    const candidates = [img.dataset && img.dataset.src, img.getAttribute("data-original"), img.src];
    for (const url of candidates) {
      if (url && !url.startsWith("data:")) return url;
    }
    return null;
  }

  function pageKey(url) {
    const hash = url.indexOf("#");
    return hash >= 0 ? url.slice(0, hash) : url;
  }

  const PageFinder = { isMangaImage, realImageUrl, pageKey, MIN_SIDE, MIN_LONG_SIDE };
  if (typeof module !== "undefined") module.exports = PageFinder;
  else (globalThis.AnkiManga ??= {}).PageFinder = PageFinder;
})();
