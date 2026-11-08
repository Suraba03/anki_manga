#!/usr/bin/env node
// The Chrome Web Store screenshots (1280x800, RGB): headline strip, then the reader on the left and the extension panel on the right.
//   node tools/demo/screenshots.mjs [--live]     (--live: ask the free server instead of using tools/.cache/demo-free.json)
//   1 explained bubble (highlighted)   2 dictionary entry + "✓ added"   3 the Anki card   4 settings
// Everything inside the frames is the extension's own UI (the highlight is the extension's own `am-flash` style, kept on);
// the strips, the card view's frame and the panel's crop are our composition. Also writes demo-poster.png and the
// captures in dist/store/tmp/ that promo.mjs uses.
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUT, sleep, waitFor } from "./common.mjs";
import { startSession, VIEW, SITE_HOST, text, centerOf, clickMouse } from "./session.mjs";
import { composite, cropPanel, stack, stripHtml, cardPageHtml } from "./compose.mjs";

const live = process.argv.includes("--live");
const TMP = join(OUT, "tmp");
mkdirSync(TMP, { recursive: true });
for (const f of readdirSync(OUT)) if (/^screenshot-\d+\.png$/.test(f)) rmSync(join(OUT, f));
const s = await startSession({ live });
let ok = false;
try {
  const reader = await s.openReader();
  await s.waitEngine();
  await reader.send("Page.navigate", { url: `${s.origin}/blank` });
  await sleep(800);
  const panel = await s.openPanel();
  await waitFor(async () => (await text(panel, "#status")).startsWith("Ready"), "the panel to show the model status", 30000);
  await waitFor(async () => (await text(panel, "#site-name")) === SITE_HOST, `the site name ${SITE_HOST}`, 10000);

  const grab = async (cdp, name) => {
    const css = { w: cdp === reader ? VIEW.readerW : VIEW.panelW, h: VIEW.h };
    const r = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: css.w, height: css.h, scale: 1 } });
    const f = join(TMP, `${name}.png`);
    writeFileSync(f, Buffer.from(r.data, "base64"));
    return f;
  };
  const strip = (name, headline, opts) => s.renderHtml(stripHtml(headline, opts), 1280, 60, join(TMP, `strip-${name}.png`));
  const noLoopback = async () => {
    for (const [n, cdp] of [["reader", reader], ["panel", panel]]) {
      if (await cdp.evaluate('document.body.innerText.includes("127.0.0.1")')) throw new Error(`127.0.0.1 is visible in the ${n}`);
    }
  };
  // The extension's own highlight (orange outline) on the clicked bubble, and its "✓ 6" badge shown (it fades 2.5 s after it is done).
  const decorate = () =>
    reader.evaluate(`(() => {
      const e = [...document.querySelectorAll(".am-bubble")].find((e) => e.textContent.includes("せっかく")); e.classList.add("am-flash");
      window.__pin ||= setInterval(() => document.querySelectorAll(".am-badge.am-faded").forEach((b) => b.classList.remove("am-faded")), 40);
    })()`);
  // The panel is cut under the last explanation row that is fully visible, the rest filled with the panel's own background.
  const shoot = async (n, headline) => {
    await noLoopback();
    const [a, full] = await Promise.all([grab(reader, `shot-${n}-reader`), grab(panel, `shot-${n}-panel-full`)]);
    const cut = await panel.evaluate(`Math.max(...[...document.querySelectorAll(".entry .note")].map((e) => e.getBoundingClientRect().bottom).filter((b) => b <= ${VIEW.h} - 8)) + 6`);
    const b = join(TMP, `shot-${n}-panel.png`);
    cropPanel(full, cut, b);
    const out = join(OUT, `screenshot-${n}.png`);
    composite(a, b, await strip(n, headline), out);
    console.log(`wrote ${out} (panel cut at ${Math.round(cut)} px)`);
  };

  await reader.send("Page.navigate", { url: `${s.origin}/` });
  await waitFor(async () => /✓ 6/.test(await reader.evaluate('[...document.querySelectorAll(".am-badge")].map((b) => b.dataset.text).join("|")')), "all bubbles read", 120000);

  // 1: click the bubble
  const [bx, by] = await centerOf(reader, ".am-bubble", "せっかく");
  await clickMouse(reader, bx, by);
  await reader.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 });
  await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .tok").length')) > 0, "the clickable sentence", 30000);
  await waitFor(async () => (await panel.evaluate('!!document.querySelector(".entry .explain:not([hidden]) .note") || !!document.querySelector(".entry .msg:not([hidden])")')), "the explanation", 60000);
  const msg = await text(panel, ".entry .msg");
  if (msg) throw new Error(`the explanation failed: ${msg}`);
  await sleep(800);
  await decorate();
  await sleep(800);
  // where things are in shot 1, for the promo tiles (crops of the real UI on row boundaries)
  const layout = await panel.evaluate(`(() => {
    const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const toks = [...document.querySelectorAll(".entry .tok")];
    const i0 = toks.findIndex((t) => t.textContent.includes("海")), i1 = toks.findIndex((t) => t.textContent.includes("歩")) + 1;
    const rs = toks.slice(i0, i1 + 1).map(box);
    const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.w)), y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    const notes = [...document.querySelectorAll(".entry .note")].map(box);
    return { chip: { x: x0, y: y0 - 14, w: x1 - x0, h: y1 - y0 + 18 }, entryTop: box(document.querySelector(".entry h5")).y - 8, notesBottom: notes.map((n) => n.y + n.h) };
  })()`);
  layout.img = await reader.evaluate(`(() => { const b = document.querySelector("img").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  writeFileSync(join(TMP, "shot-1-layout.json"), JSON.stringify(layout));
  await shoot(1, "Click any bubble: furigana + grammar");
  // the poster is this frame under the product name instead of a headline
  composite(join(TMP, "shot-1-reader.png"), join(TMP, "shot-1-panel.png"), await strip("brand", "Manga OCR &amp; Mining for Anki"), join(OUT, "demo-poster.png"));

  // 2: a word of the sentence -> dictionary entry -> "+" -> "✓ added" (fake AnkiConnect on 8766, deck "manga mining",
  // confirmed first in Settings: no deck is picked silently)
  await waitFor(() => panel.evaluate('!document.getElementById("deck-use").hidden'), "the Use-deck button", 30000);
  await panel.evaluate('document.getElementById("deck-use").click()');
  await waitFor(async () => (await text(panel, "#deck-target")) === "Cards go to → manga mining", "the deck line", 10000);
  const [tx, ty] = await centerOf(panel, ".entry .tok", "歩");
  await clickMouse(panel, tx, ty);
  await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .dict-entry").length')) > 0, "the dictionary entry", 60000);
  const [px, py] = await centerOf(panel, ".entry .dict-entry button");
  await clickMouse(panel, px, py);
  await waitFor(async () => (await text(panel, ".entry .dict-entry button")) === "✓ added", "the card to be added", 30000);
  await panel.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 });
  await sleep(400);
  await decorate();
  await sleep(800);
  await shoot(2, "Click a word: dictionary entry, one-click Anki card");
  const note = s.anki.notes[0];
  writeFileSync(join(TMP, "anki-note.json"), JSON.stringify({ note, model: s.anki.state.model }));
  console.log(`card: deck=${note.deckName} Word=${note.fields.Word} picture=${note.picture?.[0]?.filename}`);

  // 3: the card as Anki shows it (the note the fake received, rendered with the note type's own templates and CSS)
  const cardPng = await s.renderHtml(cardPageHtml(note, s.anki.state.model), 1280, 740, join(TMP, "card-view.png"));
  stack(cardPng, await strip(3, "Your card in Anki: sentence, reading, meaning, picture"), join(OUT, "screenshot-3.png"));
  console.log(`wrote ${join(OUT, "screenshot-3.png")}`);

  // 4: settings (cropped above "About"; "Auto" is the default recognition mode, the harness had forced prefetch)
  await panel.evaluate("document.getElementById('perf').value = 'auto'; document.getElementById('perf').dispatchEvent(new Event('change', { bubbles: true }))");
  await clickMouse(panel, ...(await centerOf(panel, "#settings summary")));
  await waitFor(async () => (await panel.evaluate("document.getElementById('settings').open")), "the settings", 5000);
  await panel.evaluate("window.scrollTo(0, 0)");
  await panel.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 });
  await sleep(500);
  const cutY = await panel.evaluate("document.querySelector('.settings h5').getBoundingClientRect().top - 15");
  console.log(`settings: ${await text(panel, "#status")} | ${await text(panel, "#free-left")} | deck=${await panel.evaluate("document.getElementById('deck').value")} | cut at ${Math.round(cutY)} px`);
  await noLoopback();
  const [r4, p4] = await Promise.all([grab(reader, "shot-4-reader"), grab(panel, "shot-4-panel-full")]);
  cropPanel(p4, cutY, join(TMP, "shot-4-panel.png"));
  composite(r4, join(TMP, "shot-4-panel.png"), await strip(4, "Runs on your device. Free, no account"), join(OUT, "screenshot-4.png"));
  console.log(`wrote ${join(OUT, "screenshot-4.png")}`);
  console.log(`free tier: ${s.free.requests} request(s) from the panel, ${s.free.live} live to the server; redirected from 8765: ${s.redirected}`);
  ok = true;
} finally {
  await s.close();
}
process.exit(ok ? 0 : 1);
