// Pure geometry for the invisible text layer: which characters go on which detected
// line, and where each line sits in displayed pixels (relative to the image's top-left).
(() => {
  const FONT_FILL = 0.9; // glyph size as a fraction of the line's thickness

  function splitTextIntoLines(text, lineLengths) {
    const chars = Array.from(text);
    const n = chars.length;
    const k = lineLengths.length;
    if (k === 0) return [text];
    if (n <= k) return lineLengths.map((_, i) => chars[i] || "");
    const total = lineLengths.reduce((a, b) => a + Math.max(b, 0), 0) || k;
    const bounds = [];
    let cum = 0;
    for (let i = 0; i < k - 1; i++) {
      cum += total === k ? 1 : Math.max(lineLengths[i], 0);
      let b = Math.round((n * cum) / total);
      const prev = i === 0 ? 0 : bounds[i - 1];
      b = Math.max(b, prev + 1); // no empty line while chars remain
      b = Math.min(b, n - (k - 1 - i)); // leave at least one char per remaining line
      bounds.push(b);
    }
    bounds.push(n);
    return bounds.map((end, i) => chars.slice(i === 0 ? 0 : bounds[i - 1], end).join(""));
  }

  function quadRect(quad) {
    const xs = quad.map((p) => p[0]);
    const ys = quad.map((p) => p[1]);
    const x1 = Math.min(...xs);
    const y1 = Math.min(...ys);
    return { x: x1, y: y1, w: Math.max(...xs) - x1, h: Math.max(...ys) - y1 };
  }

  function layoutBubble(bubble, natural, displayed) {
    const s = displayed.w / natural.w;
    const [bx1, by1, bx2, by2] = bubble.box;
    const box = { left: bx1 * s, top: by1 * s, width: (bx2 - bx1) * s, height: (by2 - by1) * s };
    let rects = (bubble.lines || []).map(quadRect);
    if (rects.length === 0) rects = [{ x: bx1, y: by1, w: bx2 - bx1, h: by2 - by1 }];
    rects.sort(bubble.vertical ? (a, b) => b.x - a.x : (a, b) => a.y - b.y);
    const chunks = splitTextIntoLines(bubble.text || "", rects.map((r) => (bubble.vertical ? r.h : r.w)));
    const lines = rects.map((r, i) => {
      const text = chunks[i] || "";
      const n = Math.max(Array.from(text).length, 1);
      const thick = (bubble.vertical ? r.w : r.h) * s;
      const long = (bubble.vertical ? r.h : r.w) * s;
      const fontSize = thick * FONT_FILL;
      return {
        text,
        left: r.x * s,
        top: r.y * s,
        width: r.w * s,
        height: r.h * s,
        fontSize,
        letterSpacing: Math.max(0, (long - n * fontSize) / n),
      };
    });
    return { box, vertical: !!bubble.vertical, lines };
  }

  const Layout = { splitTextIntoLines, layoutBubble };
  if (typeof module !== "undefined") module.exports = Layout;
  else (globalThis.AnkiManga ??= {}).Layout = Layout;
})();
