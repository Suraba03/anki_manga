// Frame composition: ffmpeg joins the reader and the panel (1280x740) under a 60 px headline strip (1280x800 in all),
// plus the HTML of the strips, the Anki card view and the end card.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION } from "./common.mjs";

export const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
export const DIVIDER = "0xc9c9c4";
export const STRIP_BG = "0x111114";
export const PANEL_BG = "0x1d1d1f"; // the panel page's own dark background
const SANS = `'Helvetica Neue', 'Hiragino Sans', system-ui, sans-serif`;
const ICON = `data:image/png;base64,${readFileSync(join(EXTENSION, "icons/icon128.png")).toString("base64")}`;

const ff = (...args) => execFileSync(FFMPEG, ["-y", "-v", "error", ...args]);

// reader (759x740) | divider | panel (520x740) under the strip -> 1280x800 RGB PNG
export function composite(readerPng, panelPng, stripPng, out) {
  ff("-i", readerPng, "-i", panelPng, "-f", "lavfi", "-i", `color=c=${DIVIDER}:s=1x740`, "-i", stripPng,
    "-filter_complex", `[0][2][1]hstack=inputs=3,pad=1280:800:0:60:color=${STRIP_BG}[b];[b][3]overlay=0:0,format=rgb24`, "-frames:v", "1", out);
}

// strip over a full-width 1280x740 image (the card view) -> 1280x800 RGB PNG
export function stack(contentPng, stripPng, out) {
  ff("-i", stripPng, "-i", contentPng, "-filter_complex", "[0][1]vstack=inputs=2,format=rgb24", "-frames:v", "1", out);
}

// Keeps the top `y` pixels of the panel capture and fills the rest with the panel's own background.
export function cropPanel(panelPng, y, out) {
  ff("-i", panelPng, "-vf", `crop=520:${Math.round(y)}:0:0,pad=520:740:0:0:color=${PANEL_BG}`, "-frames:v", "1", out);
}

// a full 1280x800 image (card view, end card) -> RGB24 PNG
export function toRgb(png, out) {
  ff("-i", png, "-pix_fmt", "rgb24", "-frames:v", "1", out);
}

export function stripHtml(text, { icon = true } = {}) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:60px;background:#${STRIP_BG.slice(2)};border-bottom:3px solid #f5a524;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:14px;font:800 30px ${SANS};color:#fff;letter-spacing:-.2px;white-space:nowrap">
${icon ? `<img src="${ICON}" width="34" height="34" style="border-radius:8px">` : ""}<span>${text}</span></body>`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// The note the fake AnkiConnect received, rendered through the real note type (templates and CSS from createModel),
// front and back side by side in a dark, neutral frame. 1280x740 (goes under the strip).
export function cardPageHtml(note, model) {
  const tpl = model.cardTemplates[0];
  const pic = note.picture?.[0];
  const fields = { ...note.fields, Picture: pic ? `<img src="data:image/jpeg;base64,${pic.data}">` : "" };
  const fill = (t, f) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => f[k] ?? "");
  const front = fill(tpl.Front, fields);
  const back = fill(tpl.Back, { ...fields, FrontSide: front });
  return `<!doctype html><meta charset="utf-8"><style>${model.css}
body{margin:0;width:1280px;height:740px;background:#232326;font-family:${SANS};color:#bbb;display:flex;gap:22px;padding:20px 30px 0;box-sizing:border-box;align-items:flex-start}
.col{display:flex;flex-direction:column;gap:8px}.lbl{font:700 14px ${SANS};letter-spacing:.08em;text-transform:uppercase;color:#8d8d92}
.win{border-radius:10px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.5);border:1px solid #3a3a3e;zoom:.86}
.win .card{padding:18px 22px 22px}
.meta{font:13px ${SANS};color:#8d8d92}
</style><body>
<div class="col" style="width:420px"><div class="lbl">Front</div><div class="win"><div class="card">${front}</div></div>
<div class="meta">Deck: ${esc(note.deckName)} · Note type: ${esc(note.modelName)}</div></div>
<div class="col" style="width:778px"><div class="lbl">Back</div><div class="win"><div class="card">${back}</div></div></div>
</body>`;
}

export function endCardHtml() {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;background:radial-gradient(900px 600px at 50% 40%,#3a3a3f 0,#17171a 75%);color:#fff;font-family:${SANS};display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
<img src="${ICON}" width="150" height="150" style="border-radius:32px;box-shadow:0 10px 34px rgba(0,0,0,.6)">
<div style="margin-top:38px;font-size:68px;font-weight:800;letter-spacing:-1px">Manga OCR &amp; Mining for Anki</div>
<div style="margin-top:24px;font-size:34px;font-weight:700;color:#f5a524">Free · no account · runs on your device</div></body>`;
}
