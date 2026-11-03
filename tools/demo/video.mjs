#!/usr/bin/env node
// The demo video: dist/store/demo.mp4 (1280x800, H.264, yuv420p, 30 fps).
//   node tools/demo/video.mjs [--live]     (--live: ask the free server instead of using tools/.cache/demo-free.json)
// Flow: page loads and is read -> click a bubble -> click a word -> "+" -> the card as Anki shows it -> end card.
// Reader and panel windows are recorded with Page.startScreencast (frames carry wall-clock timestamps, so the halves stay
// in sync when ffmpeg joins them). A drawn cursor (headless Chrome has none) eases between the targets while real CDP
// mouse events go to the same points; clicks show a ring. The captions are a 60 px strip above the frame.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { OUT, sleep, waitFor } from "./common.mjs";
import { startSession, VIEW, SITE_HOST, text, centerOf, clickMouse, moveMouse } from "./session.mjs";
import { FFMPEG, DIVIDER, STRIP_BG, stripHtml, cardPageHtml, endCardHtml, stack, toRgb } from "./compose.mjs";

const live = process.argv.includes("--live");
const TMP = join(OUT, "tmp");
const FRAMES = join(TMP, "frames");
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const now = () => Date.now() / 1000;
const FPROBE = FFMPEG.replace(/ffmpeg$/, "ffprobe");
const CARD_SECONDS = 5.5;
const END_SECONDS = 3.0;
const FADE = 0.5;

class Recorder {
  constructor(cdp, name, w, h) {
    Object.assign(this, { cdp, name, w, h, frames: [] });
  }
  async start() {
    this.cdp.on("Page.screencastFrame", (p) => {
      const file = join(FRAMES, `${this.name}-${String(this.frames.length).padStart(6, "0")}.png`);
      writeFileSync(file, Buffer.from(p.data, "base64"));
      this.frames.push({ ts: p.metadata.timestamp, file });
      this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "png", maxWidth: this.w, maxHeight: this.h, everyNthFrame: 1 });
  }
  stop() {
    return this.cdp.send("Page.stopScreencast");
  }
}

// ffmpeg concat list: each frame is shown from its timestamp to the next one, over [t0, t1].
function concatList(frames, t0, t1, file) {
  let i = frames.findLastIndex((f) => f.ts <= t0);
  if (i < 0) i = 0;
  const lines = [];
  for (; i < frames.length && frames[i].ts < t1; i++) {
    const start = Math.max(frames[i].ts, t0);
    const end = Math.min(frames[i + 1]?.ts ?? t1, t1);
    if (end - start < 1e-4) continue;
    lines.push(`file '${frames[i].file}'`, `duration ${(end - start).toFixed(5)}`);
  }
  lines.push(lines[lines.length - 2]); // the concat demuxer ignores the duration of the last entry
  writeFileSync(file, lines.join("\n"));
}

const ff = (args) => execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { stdio: "inherit" });
const duration = (f) => Number(execFileSync(FPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }));

const s = await startSession({ live });
let ok = false;
try {
  const reader = await s.openReader();
  await s.waitEngine();
  await reader.send("Page.navigate", { url: `${s.origin}/blank` });
  await sleep(800);
  const panel = await s.openPanel();
  await waitFor(async () => (await text(panel, "#status")).startsWith("Ready"), "the panel status", 30000);
  await waitFor(async () => (await text(panel, "#site-name")) === SITE_HOST, `the site name ${SITE_HOST}`, 10000);
  // The first dictionary lookup parses the dictionary: do that before recording (engine warm-up is not part of the video).
  await s.sw.evaluate('engineCall({type: "eng:lookup", surface: "歩い", lemma: "歩く", reading: "アルイ"})');

  const recs = [new Recorder(reader, "reader", VIEW.readerW, VIEW.h), new Recorder(panel, "panel", VIEW.panelW, VIEW.h)];
  await Promise.all(recs.map((r) => r.start()));
  await waitFor(() => recs.every((r) => r.frames.length > 0), "the first frames", 10000);
  await sleep(300);
  const captions = [];
  let open = null;
  let T0 = 0;
  const caption = (txt) => {
    if (open) open.t1 = now() - T0;
    open = txt ? { t0: now() - T0, text: txt } : null;
    if (open) captions.push(open);
  };

  // 1: the page loads, the bubbles are read (the recording starts with the navigation: no blank opening)
  T0 = now();
  caption("Bubbles are read on your device");
  await reader.send("Page.navigate", { url: `${s.origin}/` });
  await waitFor(async () => /✓ 6/.test(await reader.evaluate('[...document.querySelectorAll(".am-badge")].map((b) => b.dataset.text).join("|")')), "all bubbles read", 120000);
  await sleep(2000);

  // 2: click a bubble (it stays highlighted with the extension's own outline)
  caption("Click a bubble: furigana + grammar");
  const [bx, by] = await centerOf(reader, ".am-bubble", "せっかく");
  await reader.evaluate("window.__cursor.show(560, 650)");
  await sleep(200);
  await moveMouse(reader, bx, by, 1000);
  await sleep(150);
  await clickMouse(reader, bx, by);
  await reader.evaluate(`(() => { const e = [...document.querySelectorAll(".am-bubble")].find((e) => e.textContent.includes("せっかく")); setInterval(() => e.classList.add("am-flash"), 80); })()`);
  await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .tok").length')) > 0, "the clickable sentence", 30000);
  await waitFor(async () => (await panel.evaluate('!!document.querySelector(".entry .explain:not([hidden]) .note") || !!document.querySelector(".entry .msg:not([hidden])")')), "the explanation", 60000);
  if (await text(panel, ".entry .msg")) throw new Error("the explanation failed");
  await sleep(3200);

  // 3: click a word. The pointer leaves the reader on its right edge and enters the panel on its left edge.
  caption("Click a word: dictionary entry");
  const [tx, ty] = await centerOf(panel, ".entry .tok", "歩");
  const edgeY = 300;
  await moveMouse(reader, VIEW.readerW - 3, edgeY, 650);
  await reader.evaluate("window.__cursor.hide()");
  await panel.evaluate(`window.__cursor.show(2, ${edgeY})`);
  await moveMouse(panel, tx, ty, 700);
  await sleep(150);
  await clickMouse(panel, tx, ty);
  await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .dict-entry").length')) > 0, "the dictionary entry", 60000);
  await sleep(2400);

  // 4: add the card
  caption("One click: an Anki card");
  const [px, py] = await centerOf(panel, ".entry .dict-entry button");
  await moveMouse(panel, px, py, 700);
  await sleep(150);
  await clickMouse(panel, px, py);
  await waitFor(async () => (await text(panel, ".entry .dict-entry button")) === "✓ added", "the card to be added", 30000);
  await sleep(2600);
  caption(null);
  const T1 = now();
  await Promise.all(recs.map((r) => r.stop()));
  console.log(`recorded ${(T1 - T0).toFixed(1)} s; frames reader=${recs[0].frames.length} panel=${recs[1].frames.length}; free tier: ${s.free.requests} request(s), ${s.free.live} live`);

  // ---- stills: caption strips, the card view, the end card ----
  const strips = [];
  for (const [i, c] of captions.entries()) strips.push(await s.renderHtml(stripHtml(c.text), 1280, 60, join(TMP, `vstrip-${i}.png`)));
  const note = s.anki.notes[0];
  const cardRaw = await s.renderHtml(cardPageHtml(note, s.anki.state.model), 1280, 740, join(TMP, "vcard-raw.png"));
  const cardStrip = await s.renderHtml(stripHtml("Your card in Anki: sentence, reading, meaning, picture"), 1280, 60, join(TMP, "vstrip-card.png"));
  const cardPng = join(TMP, "vcard.png");
  stack(cardRaw, cardStrip, cardPng);
  const endPng = join(TMP, "vend.png");
  toRgb(await s.renderHtml(endCardHtml(), 1280, 800, join(TMP, "vend-raw.png")), endPng);

  // ---- assemble ----
  const start = Math.max(recs[0].frames[0].ts, recs[1].frames[0].ts, T0);
  recs.forEach((r) => concatList(r.frames, start, T1, join(FRAMES, `${r.name}.txt`)));
  const shift = start - T0;
  const inputs = captions.flatMap((_, i) => ["-i", strips[i]]);
  let chain = `[0]fps=30,format=yuv420p[a];[1]fps=30,format=yuv420p[b];[2]format=yuv420p[d];[a][d][b]hstack=inputs=3:shortest=1,pad=1280:800:0:60:color=${STRIP_BG}[v0]`;
  captions.forEach((c, i) => {
    chain += `;[v${i}][${3 + i}]overlay=0:0:enable='between(t,${Math.max(0, c.t0 - shift).toFixed(2)},${((c.t1 ?? T1 - T0) - shift).toFixed(2)})'[v${i + 1}]`;
  });
  const main = join(TMP, "main.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", join(FRAMES, "reader.txt"), "-f", "concat", "-safe", "0", "-i", join(FRAMES, "panel.txt"),
    "-f", "lavfi", "-i", `color=c=${DIVIDER}:s=1x740:r=30`, ...inputs,
    "-filter_complex", `${chain};[v${captions.length}]format=yuv420p[v]`, "-map", "[v]", "-t", (T1 - start).toFixed(3),
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", main]);
  const d0 = duration(main);

  const out = join(OUT, "demo.mp4");
  const norm = (i) => `[${i}]fps=30,setsar=1,format=yuv420p`;
  ff(["-i", main, "-loop", "1", "-framerate", "30", "-t", String(CARD_SECONDS), "-i", cardPng, "-loop", "1", "-framerate", "30", "-t", String(END_SECONDS), "-i", endPng,
    "-filter_complex",
    `${norm(0)}[m];${norm(1)}[c];${norm(2)}[e];[m][c]xfade=transition=fade:duration=${FADE}:offset=${(d0 - FADE).toFixed(3)}[x1];[x1][e]xfade=transition=fade:duration=${FADE}:offset=${(d0 + CARD_SECONDS - 2 * FADE).toFixed(3)}[v]`,
    "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out]);
  const dur = duration(out);
  console.log(`wrote ${out} (${dur.toFixed(1)} s)`);
  if (dur < 25 || dur > 45) throw new Error(`the video is ${dur.toFixed(1)} s, wanted 25-45 s`);
  ok = true;
} finally {
  await s.close();
}
process.exit(ok ? 0 : 1);
