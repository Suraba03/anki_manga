#!/usr/bin/env node
// Store promo tiles: dist/store/promo-small.png (440x280) and dist/store/promo-marquee.png (1400x560), 24-bit RGB PNGs.
//   node tools/demo/promo.mjs     (needs dist/store/demo-page.png and the shot-1 captures + layout that screenshots.mjs writes in dist/store/tmp/)
// Art: crops of the real UI (the page with the extension's highlighted bubble and badge, the panel's furigana and explanation rows).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, OUT, ROOT, installChrome, launch, startServer, waitFor, sleep } from "./common.mjs";
import { FFMPEG } from "./compose.mjs";

const NAME = "Manga OCR &amp; Mining for Anki";
const FONT = `'Helvetica Neue', 'Hiragino Sans', system-ui, sans-serif`;
const L = JSON.parse(readFileSync(join(OUT, "tmp", "shot-1-layout.json"), "utf8"));

// the explanation rows of the panel, from the entry's heading to the bottom of the third note (a row boundary)
const rowsTop = Math.round(L.entryTop), rowsBottom = Math.round(L.notesBottom[2] + 6);
const rowsH = rowsBottom - rowsTop;

const small = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:440px;height:280px;overflow:hidden;position:relative;background:#1d1d1f;font-family:${FONT};color:#fff">
<div style="position:absolute;inset:0;opacity:.2;background:url(/page.png) no-repeat;background-size:560px auto;background-position:-60px -330px;filter:grayscale(1)"></div>
<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(29,29,31,.55),rgba(29,29,31,.92))"></div>
<img src="/icon.png" width="58" height="58" style="position:absolute;left:26px;top:26px;border-radius:13px;box-shadow:0 3px 10px rgba(0,0,0,.5)">
<div style="position:absolute;right:20px;top:24px;width:${Math.round(L.chip.w * 1.25)}px;height:${Math.round(L.chip.h * 1.25)}px;border-radius:9px;border:1px solid #4a4a4e;box-shadow:0 5px 16px rgba(0,0,0,.55);background:#1d1d1f url(/panel.png) no-repeat;background-size:${520 * 1.25}px auto;background-position:-${Math.round(L.chip.x * 1.25)}px -${Math.round(L.chip.y * 1.25)}px"></div>
<div style="position:absolute;left:26px;top:112px;font-size:35px;line-height:1.1;font-weight:800;letter-spacing:-.5px">Manga OCR &amp;<br>Mining for Anki</div>
<div style="position:absolute;left:26px;top:214px;font-size:15.5px;font-weight:700;color:#f5a524">Click a bubble → furigana, grammar, Anki card</div>`;

// page card (real capture: the highlighted bubble and the badge) at +10%, the panel rows beside it, no rotation
const cardH = 550, cardScale = cardH / L.img.h, cardW = Math.round(L.img.w * cardScale);
const insetScale = 0.86;
const marquee = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1400px;height:560px;overflow:hidden;position:relative;background:#1d1d1f;font-family:${FONT}">
<div style="position:absolute;inset:0;background:radial-gradient(900px 600px at 78% 40%,#3a3a3f 0,#1d1d1f 70%)"></div>
<div style="position:absolute;inset:0;opacity:.18;background-image:radial-gradient(#fff 1.2px,transparent 1.4px);background-size:14px 14px;-webkit-mask-image:linear-gradient(90deg,#000,transparent 60%)"></div>
<div style="position:absolute;left:84px;top:110px;width:540px;color:#fff">
  <img src="/icon.png" width="112" height="112" style="display:block;border-radius:24px;box-shadow:0 6px 22px rgba(0,0,0,.55)">
  <div style="margin-top:30px;font-size:60px;line-height:1.08;font-weight:800;letter-spacing:-.8px">${NAME}</div>
  <div style="margin-top:24px;font-size:28px;font-weight:700;color:#f5a524;letter-spacing:.3px">OCR · furigana · grammar · Anki</div>
</div>
<div style="position:absolute;left:650px;top:5px;width:${cardW}px;height:${cardH}px;background:#fff url(/reader.png) no-repeat;background-size:${Math.round(759 * cardScale)}px ${cardH}px;background-position:-${Math.round(L.img.x * cardScale)}px 0;border-radius:6px;box-shadow:0 14px 40px rgba(0,0,0,.6);outline:1px solid #000"></div>
<div style="position:absolute;left:${650 + cardW - 90}px;top:${Math.round((560 - rowsH * insetScale) / 2)}px;width:${Math.round(520 * insetScale)}px;height:${Math.round(rowsH * insetScale)}px;border-radius:12px;overflow:hidden;box-shadow:0 14px 40px rgba(0,0,0,.65);border:1px solid #3a3a3d;background:#1d1d1f url(/panel.png) no-repeat;background-size:${Math.round(520 * insetScale)}px auto;background-position:0 -${Math.round(rowsTop * insetScale)}px"></div>`;

const routes = {
  "/icon.png": { type: "image/png", file: join(ROOT, "extension/icons/icon128.png") },
  "/page.png": { type: "image/png", file: join(OUT, "demo-page.png") },
  "/panel.png": { type: "image/png", file: join(OUT, "tmp", "shot-1-panel.png") },
  "/reader.png": { type: "image/png", file: join(OUT, "tmp", "shot-1-reader.png") },
  "/small": { type: "text/html; charset=utf-8", body: small },
  "/marquee": { type: "text/html; charset=utf-8", body: marquee },
};
const PORT = 9337, SERVE = 47904;
const server = await startServer(SERVE, routes);
const profile = mkdtempSync(join(tmpdir(), "anki-manga-demo-"));
const chrome = launch(installChrome(), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"]);
try {
  const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"), "the browser");
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  for (const [name, path, w, h] of [["promo-small", "/small", 440, 280], ["promo-marquee", "/marquee", 1400, 560]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${SERVE}${path}` });
    await waitFor(() => cdp.evaluate("document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth > 0)"), "the images");
    await sleep(400);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    const raw = join(OUT, "tmp", `${name}-raw.png`);
    writeFileSync(raw, Buffer.from(shot.data, "base64"));
    // 24-bit RGB, no alpha channel (Chrome Web Store requirement)
    execFileSync(FFMPEG, ["-y", "-v", "error", "-i", raw, "-pix_fmt", "rgb24", "-frames:v", "1", join(OUT, `${name}.png`)]);
    console.log(`wrote ${join(OUT, `${name}.png`)}`);
  }
  cdp.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
