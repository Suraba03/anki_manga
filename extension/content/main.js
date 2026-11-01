// Content-script entry (filled in by the overlay task). Runs only on enabled sites.
(() => {
  if (globalThis.__ankiMangaLoaded) return;
  globalThis.__ankiMangaLoaded = true;
})();
