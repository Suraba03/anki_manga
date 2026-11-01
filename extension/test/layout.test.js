const test = require("node:test");
const assert = require("node:assert/strict");
const Layout = require("../content/layout.js");

const lens = (chunks) => chunks.map((c) => Array.from(c).length);

test("splitTextIntoLines splits proportionally", () => {
  assert.deepEqual(Layout.splitTextIntoLines("これは坂の角度が", [100, 100]), ["これは坂", "の角度が"]);
  assert.deepEqual(lens(Layout.splitTextIntoLines("あいう", [300, 100])), [2, 1]);
});

test("splitTextIntoLines with more lines than chars", () => {
  assert.deepEqual(Layout.splitTextIntoLines("あ", [10, 10, 10]), ["あ", "", ""]);
});

test("splitTextIntoLines keeps every char and never empties a line while chars remain", () => {
  const text = "役に立たねー真実はほっといていこーぜー！";
  const out = Layout.splitTextIntoLines(text, [50, 300, 300, 40]);
  assert.equal(out.join(""), text);
  assert.ok(out.every((c) => c.length > 0));
});

test("splitTextIntoLines with no lines returns the whole text as one line", () => {
  assert.deepEqual(Layout.splitTextIntoLines("あいう", []), ["あいう"]);
});

const vertical = {
  box: [860, 100, 930, 300],
  vertical: true,
  lines: [
    [[860, 100], [890, 100], [890, 300], [860, 300]], // left line, read second
    [[900, 100], [930, 100], [930, 300], [900, 300]], // right line, read first
  ],
  text: "これは坂の角度が",
};

test("layoutBubble scales and orders vertical lines right-to-left", () => {
  const out = Layout.layoutBubble(vertical, { w: 1000, h: 1400 }, { w: 500, h: 700 });
  assert.deepEqual(out.box, { left: 430, top: 50, width: 35, height: 100 });
  assert.equal(out.vertical, true);
  assert.equal(out.lines[0].left, 450);
  assert.equal(out.lines[1].left, 430);
  assert.equal(out.lines[0].text, "これは坂");
  assert.equal(out.lines[0].fontSize, 13.5);
  assert.equal(out.lines[0].letterSpacing, Math.max(0, (100 - 4 * 13.5) / 4));
});

test("layoutBubble at double display size doubles every rect", () => {
  const a = Layout.layoutBubble(vertical, { w: 1000, h: 1400 }, { w: 500, h: 700 });
  const b = Layout.layoutBubble(vertical, { w: 1000, h: 1400 }, { w: 1000, h: 1400 });
  for (const k of ["left", "top", "width", "height"]) assert.equal(b.box[k], a.box[k] * 2);
  for (const k of ["left", "top", "width", "height", "fontSize"]) assert.equal(b.lines[0][k], a.lines[0][k] * 2);
});

test("layoutBubble horizontal lines top-to-bottom, size from height", () => {
  const h = {
    box: [100, 100, 300, 160],
    vertical: false,
    lines: [
      [[100, 130], [300, 130], [300, 160], [100, 160]],
      [[100, 100], [300, 100], [300, 130], [100, 130]],
    ],
    text: "あははは",
  };
  const out = Layout.layoutBubble(h, { w: 1000, h: 1000 }, { w: 1000, h: 1000 });
  assert.equal(out.lines[0].top, 100);
  assert.equal(out.lines[0].fontSize, 27);
});

test("layoutBubble without line quads uses the box as one line", () => {
  const out = Layout.layoutBubble({ box: [0, 0, 30, 200], vertical: true, lines: [], text: "ん？" },
    { w: 100, h: 100 }, { w: 100, h: 100 });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].text, "ん？");
});
