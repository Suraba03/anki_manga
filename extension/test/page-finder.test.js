const test = require("node:test");
const assert = require("node:assert/strict");
const PageFinder = require("../content/page-finder.js");

const img = (src, dataSrc, attrs = {}) => ({
  src,
  dataset: dataSrc ? { src: dataSrc } : {},
  getAttribute: (k) => attrs[k] ?? null,
});

test("realImageUrl prefers data-src over a data: placeholder", () => {
  assert.equal(
    PageFinder.realImageUrl(img("data:image/svg+xml,%3Csvg%3E", "https://cdn/x/6.jpg")),
    "https://cdn/x/6.jpg",
  );
});

test("realImageUrl returns null for a bare placeholder", () => {
  assert.equal(PageFinder.realImageUrl(img("data:image/svg+xml,...")), null);
});

test("realImageUrl uses data-original and plain src", () => {
  assert.equal(PageFinder.realImageUrl(img("data:x", null, { "data-original": "https://cdn/o.jpg" })), "https://cdn/o.jpg");
  assert.equal(PageFinder.realImageUrl(img("https://cdn/p.jpg")), "https://cdn/p.jpg");
});

test("pageKey ignores the hash, so a lazy src swap maps to the same page", () => {
  assert.equal(PageFinder.pageKey("https://cdn/a.jpg#x"), PageFinder.pageKey("https://cdn/a.jpg"));
  assert.notEqual(PageFinder.pageKey("https://cdn/a.jpg"), PageFinder.pageKey("https://cdn/b.jpg"));
});

test("isMangaImage keeps pages and drops icons", () => {
  assert.equal(PageFinder.isMangaImage(1132, 1600), true);
  assert.equal(PageFinder.isMangaImage(300, 250), false);
  assert.equal(PageFinder.isMangaImage(1, 1), false);
});

test("isMangaElement accepts big canvases and manga images, rejects small ones", () => {
  assert.equal(PageFinder.isMangaElement({ tagName: "CANVAS", width: 800, height: 1200 }), true);
  assert.equal(PageFinder.isMangaElement({ tagName: "CANVAS", width: 300, height: 150 }), false);
  assert.equal(PageFinder.isMangaElement({ tagName: "IMG", naturalWidth: 1132, naturalHeight: 1600 }), true);
  assert.equal(PageFinder.isMangaElement({ tagName: "DIV", width: 2000, height: 2000 }), false);
});

test("visibleFraction measures how much of a rect is on screen", () => {
  assert.equal(PageFinder.visibleFraction({ left: 0, top: 0, width: 100, height: 100 }, { w: 1000, h: 1000 }), 1);
  assert.equal(PageFinder.visibleFraction({ left: 0, top: -50, width: 100, height: 100 }, { w: 1000, h: 1000 }), 0.5);
  assert.equal(PageFinder.visibleFraction({ left: 0, top: 2000, width: 100, height: 100 }, { w: 1000, h: 1000 }), 0);
});

test("realImageUrl resolves relative and protocol-relative lazy URLs against the page", () => {
  const base = "https://reader.example/manga/ch1/";
  assert.equal(PageFinder.realImageUrl(img("data:x", "/img/6.jpg"), base), "https://reader.example/img/6.jpg");
  assert.equal(PageFinder.realImageUrl(img("data:x", "//cdn.example/6.jpg"), base), "https://cdn.example/6.jpg");
  assert.equal(PageFinder.realImageUrl(img("data:x", "p6.jpg"), base), "https://reader.example/manga/ch1/p6.jpg");
});
