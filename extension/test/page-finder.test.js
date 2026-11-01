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
