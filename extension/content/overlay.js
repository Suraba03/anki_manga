// Invisible, Yomitan-scannable text layer over one manga image.
//
// Rules that keep Yomitan's {sentence} == one bubble (see design §4.3):
// - one position:absolute element per bubble (Yomitan treats it as a line break),
// - lines inside are display:inline-block spans (no <br>, no block/flex children),
// - text hidden with color:transparent only (never opacity/visibility/font-size 0).
(() => {
  const NS = (globalThis.AnkiManga ??= {});
  const STYLE_ID = "am-overlay-style";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .am-layer { position: absolute !important; pointer-events: none !important; z-index: 2147483000 !important;
        margin: 0 !important; padding: 0 !important; border: 0 !important; display: block !important; }
      .am-bubble { position: absolute !important; pointer-events: auto !important; display: block !important;
        color: transparent !important; background: transparent !important; cursor: text;
        font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif !important; font-weight: normal !important;
        line-height: 1 !important; white-space: nowrap !important; user-select: text !important;
        -webkit-user-select: text !important; margin: 0 !important; padding: 0 !important; border-radius: 4px;
        text-shadow: none !important; overflow: visible !important; }
      .am-bubble.am-vertical { writing-mode: vertical-rl !important; }
      .am-line { display: inline-block !important; position: static !important; line-height: 1 !important;
        white-space: nowrap !important; margin: 0 !important; padding: 0 !important; transform-origin: 0 0; }
      html.am-show .am-bubble { color: #c00 !important; background: rgba(255,255,255,.82) !important;
        outline: 1px solid #c00; }
      .am-bubble.am-pending:hover { outline: 1px dashed rgba(178,106,0,.9) !important; }
      .am-bubble.am-flash { outline: 2px solid #f5a524 !important; background: rgba(245,165,36,.18) !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function attach(img, page, opts) {
    injectStyle();
    const layer = document.createElement("div");
    layer.className = "am-layer";
    document.body.appendChild(layer);
    const bubbles = new Map(); // id -> {data, el}
    for (const b of page.bubbles) {
      const el = document.createElement("div");
      const received = b.text !== null && b.text !== undefined; // '' = OCR finished but found nothing
      el.className = "am-bubble" + (b.vertical ? " am-vertical" : "") + (received ? "" : " am-pending");
      el.dataset.amBubble = String(b.id);
      layer.appendChild(el);
      bubbles.set(b.id, { data: { ...b }, el, received });
      el.addEventListener("mouseenter", () => opts.onHover(page.page_id, b.id, bubbles.get(b.id).data.text));
      el.addEventListener("mouseleave", () => opts.onLeave(page.page_id, b.id));
      el.addEventListener("click", (ev) => {
        if (ev.shiftKey) return; // Shift is Yomitan's scan key; don't steal those clicks
        ev.preventDefault();
        ev.stopPropagation();
        flash(el);
        opts.onSelect(page.page_id, b.id);
      });
    }
    const natural = { w: page.width, h: page.height };
    let lastKey = "";

    function renderBubble(entry, displayed) {
      const { data, el } = entry;
      const lay = NS.Layout.layoutBubble(data, natural, displayed);
      Object.assign(el.style, {
        left: `${lay.box.left}px`,
        top: `${lay.box.top}px`,
        width: `${lay.box.width}px`,
        height: `${lay.box.height}px`,
      });
      const spans = lay.lines.map((line) => {
        const span = document.createElement("span");
        span.className = "am-line";
        span.textContent = line.text;
        span.style.fontSize = `${line.fontSize}px`;
        span.style.letterSpacing = `${line.letterSpacing}px`;
        return span;
      });
      el.replaceChildren(...spans);
      // Measure natural positions, then translate each line onto its detected rect.
      const base = el.getBoundingClientRect();
      const rects = spans.map((s) => s.getBoundingClientRect());
      spans.forEach((span, i) => {
        const line = lay.lines[i];
        const dx = line.left - lay.box.left - (rects[i].left - base.left);
        const dy = line.top - lay.box.top - (rects[i].top - base.top);
        span.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    }

    function update(force = false) {
      if (!img.isConnected) return;
      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      Object.assign(layer.style, {
        left: `${r.left + window.scrollX}px`,
        top: `${r.top + window.scrollY}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      const key = `${r.width.toFixed(1)}x${r.height.toFixed(1)}`;
      if (!force && key === lastKey) return;
      lastKey = key;
      const displayed = { w: r.width, h: r.height };
      for (const entry of bubbles.values()) renderBubble(entry, displayed);
    }

    function setText(bubbleId, text) {
      const entry = bubbles.get(bubbleId);
      if (!entry) return;
      entry.received = true;
      entry.el.classList.remove("am-pending");
      if (entry.data.text === text) return;
      entry.data.text = text;
      const r = img.getBoundingClientRect();
      if (r.width >= 2) renderBubble(entry, { w: r.width, h: r.height });
    }

    function hasText(bubbleId) {
      const entry = bubbles.get(bubbleId);
      return !!(entry && entry.data.text);
    }

    function progress() {
      let done = 0;
      for (const e of bubbles.values()) if (e.received) done++;
      return { done, total: bubbles.size };
    }

    function destroy() {
      layer.remove();
    }

    update(true);
    return { update, setText, hasText, progress, destroy, pageId: page.page_id, img };
  }

  function flash(el) {
    el.classList.add("am-flash");
    setTimeout(() => el.classList.remove("am-flash"), 600);
  }

  NS.Overlay = { attach };
})();
