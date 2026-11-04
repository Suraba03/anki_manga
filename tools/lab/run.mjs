// The lab: this checkout's extension on real reader pages, clicked like a user, with a report to read before
// saying "done". See tools/lab/README.md.
//
//   node tools/lab/run.mjs [--lab-set | --sites=a,b] [--grant-all] [--headful] [--llm=stub|replay|live:N]
//                          [--clicks=K] [--profile=keep|fresh] [--real-download] [--out=name] [--sites-file=path]
//
// Per site: open (and follow an index link), wait for the page badges, click up to K bubbles in view (the panel must
// show the text, furigana, an explanation and a dictionary entry), add one card to a fake AnkiConnect, scroll and
// click once more. Output: tools/.cache/lab/runs/<stamp>-lane<offset>/report.md, report.json and screenshots, with a
// diff against this lane's previous run. Exit code 1 when a step that passed last time fails now.
//
// Safety: the real AnkiConnect (8765) is never reached (requests are redirected to a fake; the run fails if one
// slips through). The free-tier server is never called (blocked, and the run fails). Explanations come from
// tools/lab/llm.mjs; a live key is read from ANKI_MANGA_DEEPSEEK_KEY and only ever used from node.
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Cdp, EXTENSION, ROOT, installChrome, launch, startServer, waitFor, sleep } from "../demo/common.mjs";
import { port, PORT_OFFSET } from "../ports.mjs";
import { FREE_URL } from "../../extension/lib/llm.js";
import { PROMPT_VERSION } from "../../extension/lib/prompt.js";
import { parseLlmMode, cacheKey, createBudget, answerFor, userText, chatPayload } from "./llm.mjs";
import { STEPS, combine, diffRuns, regressed, renderMarkdown } from "./report.mjs";

// ---- options -----------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.slice(name.length + 3) : true;
};
const llm = parseLlmMode(flag("llm"));
const LIVE_KEY = process.env.ANKI_MANGA_DEEPSEEK_KEY || "";
if (llm.mode === "live" && !LIVE_KEY) {
  console.error("--llm=live:N needs the env var ANKI_MANGA_DEEPSEEK_KEY (your own DeepSeek key). Use --llm=replay or stub otherwise.");
  process.exit(2);
}
const headful = !!flag("headful");
const grantAll = !!flag("grant-all");
const realDownload = !!flag("real-download");
const clicks = Number(flag("clicks") ?? 3);
const profileMode = flag("profile") ?? "keep";
if (!["keep", "fresh"].includes(profileMode)) throw new Error(`--profile must be keep or fresh, got ${profileMode}`);
const sitesFile = flag("sites-file") || join(ROOT, "tools/.cache/compat/sites.json");
let sites = JSON.parse(readFileSync(sitesFile, "utf8"));
const only = typeof flag("sites") === "string" ? flag("sites").split(",") : null;
if (only) sites = only.map((n) => sites.find((s) => s.name === n) || (() => { throw new Error(`no site named ${n}`); })());
else if (flag("lab-set")) sites = sites.filter((s) => s.lab);
if (!sites.length) throw new Error("no sites: pass --lab-set or --sites=a,b (names from the sites file)");

// ---- places and ports (per lane: both lanes can run at once) -------------------------------------------------------
const LANE = PORT_OFFSET === 0 ? "A" : PORT_OFFSET === 100 ? "B" : `offset${PORT_OFFSET}`;
const LAB = join(ROOT, "tools/.cache/lab");
const LANE_DIR = join(LAB, `lane-${PORT_OFFSET}`); // profile and extension copy: stable path = stable extension ID
const PROFILE = join(LANE_DIR, "profile");
const EXT_COPY = join(LANE_DIR, "ext");
const LLM_CACHE = join(LAB, "llm-cache.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outName = typeof flag("out") === "string" ? `-${flag("out")}` : "";
const OUT = join(LAB, "runs", `${stamp}-lane${PORT_OFFSET}${outName}`);
const LATEST = join(LANE_DIR, "latest.json"); // {report: path of this lane's previous report.json}
const CDP_PORT = port(9361);
const SERVE_PORT = port(47931);
const FAKE_ANKI_PORT = port(8786);
const REAL_ANKI_PORT = 8765;
const FREE_HOST = new URL(FREE_URL).hostname;
const LLM_HOST = "api.deepseek.com";
const VIEW = { w: 1280, h: 900 };
const PANEL = { w: 520, h: 900 };
const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
const SITE_TIMEOUT_MS = 240000;

// ---- helpers -----------------------------------------------------------------------------------------------------
const base = `http://127.0.0.1:${CDP_PORT}`;
const listTargets = async () => (await fetch(`${base}/json/list`)).json();
const jsonOf = (v) => JSON.stringify(v);
const KANJI = /\p{Script=Han}/u;

function chromeUserAgent(chromePath) {
  const v = execFileSync(chromePath, ["--version"], { encoding: "utf8" }).match(/(\d+)\./)[1];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
}

async function newWindow(w, h) {
  const v = await (await fetch(`${base}/json/version`)).json();
  const b = await Cdp.open(v.webSocketDebuggerUrl);
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank", newWindow: true, width: w, height: h });
  b.close();
  const t = (await listTargets()).find((x) => x.id === targetId);
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  cdp.targetId = targetId;
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

async function shot(cdp, file) {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  } catch {
    // a screenshot is a bonus; a page that cannot be captured is reported by its steps
  }
}

// The stand-in for AnkiConnect (as in tools/e2e): records the notes it is asked to add.
function startFakeAnki() {
  const notes = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method !== "POST") return res.end();
      const { action, params } = JSON.parse(body);
      const results = {
        requestPermission: { permission: "granted", requireApikey: false, version: 6 },
        deckNames: ["Default", "manga mining"],
        modelNames: ["Manga Mining (anki_manga)"],
        findNotes: [],
        notesInfo: [],
      };
      if (action === "addNote") notes.push(params.note);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: action === "addNote" ? notes.length : (results[action] ?? null), error: null }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", () => reject(new Error(`port ${FAKE_ANKI_PORT} is busy (another lab run of this lane?)`)));
    server.listen(FAKE_ANKI_PORT, "127.0.0.1", () => resolve({ server, notes }));
  });
}

// ---- the panel page and its network guard ----------------------------------------------------------------------
const llmCache = existsSync(LLM_CACHE) ? JSON.parse(readFileSync(LLM_CACHE, "utf8")) : {};
const budget = createBudget(llm.budget ?? 0);
const safety = { redirected: 0, blocked: [], llm: [] };

async function callLive(text, postData) {
  const resp = await fetch(`https://${LLM_HOST}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LIVE_KEY}` },
    body: postData,
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  const content = (await resp.json())?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("no content");
  // Merge into the file as it is now (the other lane may have written meanwhile).
  const onDisk = existsSync(LLM_CACHE) ? JSON.parse(readFileSync(LLM_CACHE, "utf8")) : {};
  return { content, persist: (key) => writeFileSync(LLM_CACHE, JSON.stringify({ ...onDisk, [key]: content }, null, 1)) };
}

function guard(panel, ev) {
  const cors = [
    { name: "Access-Control-Allow-Origin", value: "*" },
    { name: "Access-Control-Allow-Headers", value: "*" },
    { name: "Content-Type", value: "application/json" },
  ];
  const fulfill = (status, body) =>
    panel.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: status, responseHeaders: cors, body: Buffer.from(body).toString("base64") });
  let u = null;
  try {
    u = new URL(ev.request.url);
  } catch {
    // not network traffic of ours
  }
  const portOf = (x) => x.port || (x.protocol === "https:" ? "443" : "80");
  let reply;
  if (u && portOf(u) === String(REAL_ANKI_PORT)) {
    const target = new URL(u.href);
    target.protocol = "http:";
    target.hostname = "127.0.0.1";
    target.port = String(FAKE_ANKI_PORT);
    safety.redirected++;
    reply = panel.send("Fetch.continueRequest", { requestId: ev.requestId, url: target.href });
  } else if (u && u.hostname === FREE_HOST) {
    safety.blocked.push("free-tier server");
    reply = panel.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
  } else if (/:8765\b/.test(ev.request.url)) {
    safety.blocked.push("AnkiConnect 8765");
    reply = panel.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
  } else if (u && u.hostname === LLM_HOST) {
    reply = (async () => {
      if (ev.request.method === "OPTIONS") return fulfill(204, "");
      const text = userText(JSON.parse(ev.request.postData || "{}"));
      let persist = null;
      const r = await answerFor(llm, text, {
        cache: llmCache,
        promptVersion: PROMPT_VERSION,
        budget,
        callLive: async (t) => {
          const live = await callLive(t, ev.request.postData);
          persist = live.persist;
          return live.content;
        },
      });
      if (r.source === "live") persist?.(cacheKey(PROMPT_VERSION, text));
      safety.llm.push(r.source);
      return fulfill(200, JSON.stringify(chatPayload(r.content)));
    })();
  } else {
    reply = panel.send("Fetch.continueRequest", { requestId: ev.requestId });
  }
  Promise.resolve(reply).catch(() => {});
}

// Opens panel/panel.html as a page. The tab it "looks at" is the site tab named in sessionStorage.labTab, and its
// engine calls go straight to the offscreen document (the worker refuses am:engine from a tab).
async function openPanel(extId) {
  const panel = await newWindow(PANEL.w, PANEL.h);
  await panel.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `{ const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...rest) => send(m && m.type === "am:engine" ? { target: "offscreen", ...m.msg } : m, ...rest);
      const tab = JSON.parse(sessionStorage.getItem("labTab") || "null");
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, ...rest) => (q && q.active && tab ? Promise.resolve([{ ...tab, active: true }]) : query(q, ...rest)); }`,
  });
  panel.on("Fetch.requestPaused", (ev) => guard(panel, ev));
  await panel.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  panel.url = `chrome-extension://${extId}/panel/panel.html`;
  await panel.send("Page.navigate", { url: panel.url });
  return panel;
}

async function pointPanelAt(panel, tab) {
  await panel.evaluate(`sessionStorage.setItem("labTab", ${jsonOf(JSON.stringify(tab))})`);
  await panel.send("Page.navigate", { url: panel.url });
  await waitFor(() => panel.evaluate('document.readyState === "complete" && !!document.getElementById("entries")'), "the panel", 15000);
}

// ---- the page ------------------------------------------------------------------------------------------------------
const PAGE_FACTS = `(() => {
  const big = (w, h) => Math.min(w, h) >= 400 && Math.max(w, h) >= 600;
  return {
    mangaImgs: [...document.images].filter((i) => big(i.naturalWidth, i.naturalHeight)).length,
    canvases: [...document.querySelectorAll("canvas")].filter((c) => big(c.width, c.height)).length,
    // Shown big but empty: the site's own images did not load (its problem, not the extension's).
    brokenImgs: [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.width >= 300 && r.height >= 300 && i.naturalWidth === 0; }).length,
    layers: document.querySelectorAll(".am-layer").length,
    bubbles: document.querySelectorAll(".am-bubble").length,
    bubblesRead: document.querySelectorAll(".am-bubble:not(.am-pending)").length,
    badges: [...new Set([...document.querySelectorAll(".am-badge")].map((b) => b.dataset.text).filter(Boolean))],
  };
})()`;

// Bubbles in the viewport: [{index, x, y, read}] (index into document.querySelectorAll(".am-bubble")).
const BUBBLES_IN_VIEW = `(() => [...document.querySelectorAll(".am-bubble")].map((el, index) => {
  const r = el.getBoundingClientRect();
  const visible = r.width > 8 && r.height > 8 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  return visible && { index, x: r.left + r.width / 2, y: r.top + r.height / 2, read: !el.classList.contains("am-pending"), clicked: el.dataset.labClicked === "1" };
}).filter(Boolean))()`;

// Clicks a bubble with the mouse, as a user would. If a page element covers it, notes that and clicks it directly.
async function clickBubble(tab, b) {
  const top = await tab.evaluate(`(() => { const el = document.querySelectorAll(".am-bubble")[${b.index}]; el.dataset.labClicked = "1";
    const at = document.elementFromPoint(${b.x}, ${b.y}); return at === el || el.contains(at); })()`);
  if (top) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await tab.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
    }
    return null;
  }
  await tab.evaluate(`document.querySelectorAll(".am-bubble")[${b.index}].click()`);
  return "covered by a page element (clicked directly)";
}

const panelText = (panel, sel) => panel.evaluate(`document.querySelector(${jsonOf(sel)})?.textContent ?? ""`);
const entryCount = (panel) => panel.evaluate('document.querySelectorAll("#entries .entry").length');

// After a bubble click: what the newest panel entry shows. -> {text, furigana, explanation, dictionary, entry}
async function readEntry(panel, before) {
  const out = {};
  const E = "#entries .entry:first-child";
  try {
    await waitFor(async () => (await entryCount(panel)) > before && (await panelText(panel, `${E} .jp`)).trim(), "the bubble text in the panel", 30000);
  } catch {
    return { text: { ok: false, note: "the panel showed no text for the clicked bubble" } };
  }
  const jp = (await panelText(panel, `${E} .jp`)).trim();
  out.text = { ok: true };
  const rt = await panel.evaluate(`document.querySelectorAll(${jsonOf(`${E} .jp rt`)}).length`);
  out.furigana = rt > 0 ? { ok: true } : KANJI.test(jp) ? { ok: false, note: "kanji without readings" } : { ok: null, note: "no kanji in the line" };
  try {
    const ex = await waitFor(async () => {
      const tr = (await panelText(panel, `${E} .tr`)).trim();
      if (tr.startsWith("“")) return { ok: true };
      const msg = await panel.evaluate(`(() => { const m = document.querySelector(${jsonOf(`${E} .msg`)}); return m && !m.hidden ? m.textContent : ""; })()`);
      if (msg && !/still being read/.test(msg)) return { ok: false, note: msg.slice(0, 160) };
      return null;
    }, "the explanation", 45000);
    out.explanation = ex;
  } catch {
    out.explanation = { ok: false, note: "no explanation within 45 s" };
  }
  // The dictionary: up to 3 words of the line (one can be a name or a misread, with no entry; that is not a failure
  // of the dictionary). ✓ on the first word with an entry, ✗ when none of them had one.
  const TOK = jsonOf(`${E} .tok`);
  const words = await panel.evaluate(`[...document.querySelectorAll(${TOK})].map((t, i) => /[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]/u.test(t.textContent) ? i : -1).filter((i) => i >= 0).slice(0, 3)`);
  if (!words.length) out.dictionary = { ok: null, note: "no word to click" };
  for (const [n, i] of words.entries()) {
    await panel.evaluate(`document.querySelectorAll(${TOK})[${i}].click()`);
    // One read of the box: entries, or a final message (not "Looking up…").
    const shown = await waitFor(() => panel.evaluate(`(() => { const box = document.querySelector(${jsonOf(`${E} .dict`)});
      if (!box || box.hidden) return null; if (box.querySelector(".dict-entry")) return "entry";
      const t = box.textContent.trim(); return t && !/^Looking up/.test(t) ? t : null; })()`), "the dictionary", 30000).catch(() => null);
    if (shown === "entry") {
      out.dictionary = { ok: true };
      break;
    }
    if (n < words.length - 1) continue;
    // "No dictionary entry" for a line's only one or two words is a name or a misread; for three words, or any
    // other message (the dictionary did not load, nothing shown), the dictionary is at fault.
    const none = !!shown && /^No dictionary entry/.test(shown);
    out.dictionary = none && words.length < 3
      ? { ok: null, note: `no entry for the line's ${words.length === 1 ? "only word" : "two words"} (a name or a misread?)` }
      : { ok: false, note: `${words.length} word(s) tried; last: ${(shown || "nothing shown").slice(0, 120)}` };
  }
  return out;
}

async function addCard(panel, anki) {
  const E = "#entries .entry:first-child";
  const before = anki.notes.length;
  const clicked = await panel.evaluate(`(() => { const b = document.querySelector(${jsonOf(`${E} .dict-entry button`)}) || document.querySelector(${jsonOf(`${E} .cards button`)});
    if (!b) return false; b.click(); return true; })()`);
  if (!clicked) return { ok: null, note: "no + button (no dictionary entry or suggestion)" };
  try {
    await waitFor(async () => anki.notes.length > before || (await panel.evaluate(`(() => { const m = document.querySelector(${jsonOf(`${E} .msg`)}); return !!m && !m.hidden; })()`)), "the card", 30000);
  } catch {
    return { ok: false, note: "nothing happened after +" };
  }
  const note = anki.notes[before];
  if (!note) return { ok: false, note: (await panelText(panel, `${E} .msg`)).slice(0, 160) || "the card was not sent" };
  const pic = note.picture?.[0];
  if (!pic || !(pic.data?.length > 1000)) return { ok: false, note: "the card has no picture" };
  return { ok: true };
}

// ---- one site ------------------------------------------------------------------------------------------------------
async function runSite(site, ctx, res) {
  const { steps } = res;
  const llmBefore = safety.llm.length;
  const tab = await newWindow(VIEW.w, VIEW.h);
  ctx.tab = tab;
  if (process.env.LAB_DEBUG) {
    const log = (who) => (e) => console.error(`[debug ${who}]`, e.type || e.entry?.level, String(JSON.stringify(e.args?.map((a) => a.value ?? a.description) ?? e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text)).slice(0, 300));
    tab.on("Runtime.consoleAPICalled", log("page"));
    tab.on("Runtime.exceptionThrown", log("page-exc"));
    await tab.send("Runtime.enable");
    for (const t of (await listTargets()).filter((t) => /offscreen|service_worker/.test(t.type + t.url) && t.url.startsWith("chrome-extension://"))) {
      const c = await Cdp.open(t.webSocketDebuggerUrl);
      c.on("Runtime.consoleAPICalled", log(t.type));
      c.on("Runtime.exceptionThrown", log(t.type + "-exc"));
      await c.send("Runtime.enable");
    }
  }
  const t0 = Date.now();
  const loaded = () => waitFor(() => tab.evaluate("document.readyState === 'complete'"), "page load", 40000).then(() => true, () => false);

  // 1. open (and follow the index link)
  await tab.send("Page.navigate", { url: site.url });
  let ok = await loaded();
  if (site.follow) {
    const href = await waitFor(() => tab.evaluate(`[...document.querySelectorAll("a[href]")].map((a) => a.href).find((h) => new RegExp(${jsonOf(site.follow)}).test(h)) || null`), "the follow link", 20000).catch(() => null);
    if (!href) {
      steps.open = { ok: false, note: "no link matched follow" };
      return res;
    }
    await tab.send("Page.navigate", { url: href });
    ok = await loaded();
  }
  steps.open = ok ? { ok: true } : { ok: false, note: "the page did not finish loading in 40 s" };
  const { tabId, tabUrl, tabTitle, windowId } = await ctx.sw.evaluate(`chrome.tabs.query({}).then(async (all) => {
      const url = ${jsonOf(await tab.evaluate("location.href").catch(() => ""))};
      const t = all.find((x) => x.url === url) || all.find((x) => x.active && !x.url.startsWith("chrome-extension://"));
      return t ? { tabId: t.id, tabUrl: t.url, tabTitle: t.title, windowId: t.windowId } : {};
    })`);
  await pointPanelAt(ctx.panel, { id: tabId, url: tabUrl, title: tabTitle, windowId });

  // 2. found: the extension put an overlay on at least one page (a "⚠" badge means it stopped short: report it)
  let facts = null;
  try {
    await waitFor(async () => {
      facts = await tab.evaluate(PAGE_FACTS);
      return facts.layers > 0 || facts.badges.some((t) => t.startsWith("⚠"));
    }, "a page overlay", 60000);
  } catch {
    // reported below from the facts
  }
  steps.found = facts?.layers > 0
    ? { ok: true }
    : { ok: false, note: !facts ? "page not readable" : facts.badges.length ? `badges: ${facts.badges.join("; ")}` : `nothing found (${facts.mangaImgs} manga-sized img, ${facts.canvases} canvas${facts.brokenImgs ? `, ${facts.brokenImgs} page image(s) the site did not load` : ""})` };

  // 3. a bubble with text in view (the first one with text is scrolled to, as a reader would: the first page of a
  //    long strip can sit below a header or a cover)
  let inView = [];
  let turns = 0;
  let lastTurn = Date.now();
  try {
    await waitFor(async () => {
      inView = await tab.evaluate(BUBBLES_IN_VIEW);
      if (inView.length && res.timings.firstBubbleMs == null) res.timings.firstBubbleMs = Date.now() - t0;
      if (inView.some((b) => b.read)) return true;
      // Nothing in view after a while: go to the first bubble with text (the reader may start below the fold), or,
      // with none anywhere, turn the page (a reader that opens on the cover), up to 3 times, 15 s apart.
      if (!inView.length && Date.now() - t0 > 20000) {
        const jumped = await tab.evaluate(`(() => { const b = document.querySelector(".am-bubble:not(.am-pending)"); b?.scrollIntoView({ block: "center" }); return !!b; })()`);
        if (!jumped && turns < 3 && Date.now() - lastTurn > 15000) {
          turns++;
          lastTurn = Date.now();
          for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
        }
      }
      return false;
    }, "a bubble with text in view", 75000);
    res.timings.firstTextMs = Date.now() - t0;
    steps.bubbles = { ok: true };
  } catch {
    const all = await tab.evaluate(PAGE_FACTS).catch(() => null);
    steps.bubbles = { ok: false, note: (all?.bubbles ? `${all.bubbles} bubbles, none with text after 75 s` : "no bubble") + (turns ? ` (${turns} page turn(s) tried)` : "") };
  }
  const panelState = async () => {
    const ss = await ctx.sw.evaluate('chrome.storage.session.get(["missingHosts", "captureBlocked"])');
    return { missingHosts: ss.missingHosts?.[tabId] ?? [], captureBlocked: !!ss.captureBlocked?.[tabId] };
  };

  // 4. click up to K bubbles: text, furigana, explanation, dictionary; one card
  if (steps.bubbles.ok) {
    const results = [];
    const covered = [];
    // K clicks; a few more (up to K + 3) while no line had kanji or a dictionary word yet, so a page that opens
    // with "……" or a sound effect still gets its furigana, dictionary and card checked.
    const enough = () => results.length >= clicks && results.some((r) => r.dictionary?.ok !== null) && results.some((r) => r.furigana?.ok !== null);
    for (const b of inView.filter((x) => x.read).slice(0, clicks + 3)) {
      if (enough()) break;
      const before = await entryCount(ctx.panel);
      const note = await clickBubble(tab, b);
      if (note) covered.push(note);
      const r = await readEntry(ctx.panel, before);
      results.push(r);
      if (results.length === 1) await shot(tab, join(OUT, `${site.name}-page.png`));
      if (r.dictionary?.ok && steps.card.ok === null) steps.card = await addCard(ctx.panel, ctx.anki);
    }
    if (steps.card.ok === null) steps.card = { ok: null, note: "no dictionary entry to add" };
    for (const k of ["text", "furigana", "explanation", "dictionary"]) steps[k] = combine(results.map((r) => r[k]));
    if (covered.length) steps.text.note = [steps.text.note, covered[0]].filter(Boolean).join("; ");
    await shot(ctx.panel, join(OUT, `${site.name}-panel.png`));
  }

  // 5. on to the next page and click once more (lazy loading): the mouse wheel a viewport at a time, as a reader
  //    scrolls (it reaches inner scrolling containers too); a reader that does not scroll gets ArrowLeft (next page).
  if (steps.bubbles.ok) {
    const fresh = async () => (await tab.evaluate(BUBBLES_IN_VIEW)).filter((b) => b.read && !b.clicked);
    const wait = (ms) => waitFor(async () => ((await fresh()).length ? fresh() : null), "a new bubble", ms).catch(() => []);
    // A reader that shows one page at a time (the page fits the window) turns pages with ArrowLeft; a long strip
    // scrolls. Try the likely one first, then the other.
    const paged = await tab.evaluate(`(() => { const ls = [...document.querySelectorAll(".am-layer")].map((l) => l.getBoundingClientRect())
      .filter((r) => r.bottom > 0 && r.top < innerHeight && r.width > 0); const tall = Math.max(0, ...ls.map((r) => r.height)); return tall > 0 && tall <= innerHeight * 1.2; })()`);
    const tried = [];
    const pageOn = async () => {
      tried.push("the next page (ArrowLeft)");
      for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      return wait(30000);
    };
    const scrollOn = async () => {
      const where = "JSON.stringify([scrollY, ...[...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0).map((e) => e.scrollTop)])";
      tried.push("scrolling");
      for (let i = 0; i < 6; i++) {
        const at = await tab.evaluate(where);
        await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEW.w / 2, y: VIEW.h / 2, deltaX: 0, deltaY: VIEW.h * 0.9 });
        await sleep(800);
        if (at === (await tab.evaluate(where))) break;
        const found = await wait(15000);
        if (found.length) return found;
      }
      return [];
    };
    let next = await (paged ? pageOn() : scrollOn());
    if (!next.length) next = await (paged ? scrollOn() : pageOn());
    if (!next.length) steps.scroll = { ok: false, note: `no new bubble with text after ${tried.join(", then ")}` };
    else {
      const before = await entryCount(ctx.panel);
      await clickBubble(tab, next[0]);
      const r = await readEntry(ctx.panel, before);
      steps.scroll = r.text.ok ? { ok: true } : { ok: false, note: r.text.note };
      // A first page with no kanji or no dictionary word ("……", a sound effect): this click fills those steps in.
      for (const k of ["furigana", "dictionary"]) if (steps[k].ok === null && r[k] && r[k].ok !== null) steps[k] = r[k];
      if (steps.card.ok === null && r.dictionary?.ok) steps.card = await addCard(ctx.panel, ctx.anki);
    }
    await shot(tab, join(OUT, `${site.name}-page2.png`));
  }

  if (!steps.bubbles.ok) await shot(tab, join(OUT, `${site.name}-page.png`));
  if (process.env.LAB_DEBUG) console.error("\n[debug]", site.name, JSON.stringify(await tab.evaluate(PAGE_FACTS).catch(() => null)));
  facts = await tab.evaluate(PAGE_FACTS).catch(() => facts);
  const ps = await panelState().catch(() => null);
  const finalOrigin = await tab.evaluate("location.origin").catch(() => null);
  if (finalOrigin && finalOrigin !== new URL(site.url).origin && !site.follow) res.facts = `ended on another origin than the listed one; `;
  res.facts = (res.facts || "") + (!facts ? "page not readable" : `${facts.layers} pages, ${facts.bubblesRead}/${facts.bubbles} bubbles read; badges: ${facts.badges.join("; ") || "none"}` +
    (ps?.missingHosts.length ? `; asks for ${ps.missingHosts.length} image host(s)` : "") + (ps?.captureBlocked ? "; screenshots blocked" : ""));
  res.llm = safety.llm.slice(llmBefore);
  return res;
}

// ---- main ----------------------------------------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(LANE_DIR, { recursive: true });
  if (profileMode === "fresh") rmSync(PROFILE, { recursive: true, force: true });
  // A fresh copy of this checkout's extension at a stable path (the unpacked ID, and with it the cached models, stay).
  // Its manifest lists the sites' origins: a granted host permission needs a user gesture in a real browser, and this
  // is the same grant without one ("Enable on this site"; --grant-all adds <all_urls>, as after every "Allow …").
  rmSync(EXT_COPY, { recursive: true, force: true });
  cpSync(EXTENSION, EXT_COPY, { recursive: true, filter: (p) => !/\/(node_modules|test)(\/|$)/.test(p.slice(EXTENSION.length)) });
  const manifestFile = join(EXT_COPY, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const origins = [...new Set(sites.map((s) => new URL(s.url).origin))];
  manifest.host_permissions.push(...origins.map((o) => `${o}/*`), ...(grantAll ? ["<all_urls>"] : []));
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const mirror = await startServer(SERVE_PORT, {});
  const anki = await startFakeAnki();
  const chromePath = installChrome();
  if (await fetch(`${base}/json/version`).then(() => true, () => false)) throw new Error(`port ${CDP_PORT} is in use (another lab run of this lane, or its browser still closing)`);
  const chrome = launch(chromePath, [
    ...(headful ? [] : ["--headless=new"]),
    `--load-extension=${EXT_COPY}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-unsafe-webgpu",
    `--user-agent=${chromeUserAgent(chromePath)}`, "--lang=ja", `--window-size=${VIEW.w},${VIEW.h}`,
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank",
  ]);
  const run = { stamp, lane: LANE, meta: {}, sites: [] };
  const ctx = { anki };
  let fatal = null;
  try {
    ctx.sw = await waitFor(async () => {
      for (const t of (await listTargets()).filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
        const cdp = await Cdp.open(t.webSocketDebuggerUrl);
        if ((await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null)) === OUR_NAME) return cdp;
        cdp.close();
      }
    }, "the extension service worker", 30000);
    const sw = ctx.sw;
    await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js");
    // Own-key mode with a placeholder: the guard answers every chat request (llm.mjs). Last deck: the fake's.
    await sw.evaluate(`chrome.storage.local.get("settings").then(({ settings = {} }) => chrome.storage.local.set({
      settings: { ...settings, llm: { mode: "own", provider: "deepseek", apiKey: "lab-placeholder", baseUrl: "", model: "" } },
      decks: { _last: "manga mining" },
      ${realDownload ? "" : `devModelBase: "http://127.0.0.1:${SERVE_PORT}/models/",`}
    }))`);
    await sw.evaluate("chrome.sidePanel.open = async () => {}");
    // Already enabled in a kept profile: registering again throws "Duplicate script ID", which means just that.
    for (const o of origins) await sw.evaluate(`handlers["am:enable-site"]({origin: ${jsonOf(o)}}, {})`).catch((e) => { if (!/Duplicate script ID/.test(e.message)) throw e; });
    // A fresh profile is an install: the welcome tab and an engine that may have started before the mirror was set.
    // Close both; then clear the page, text and explanation caches so every run reads the pages anew.
    for (const t of (await listTargets()).filter((t) => t.type === "page" && t.url.endsWith("/welcome/welcome.html"))) await fetch(`${base}/json/close/${t.id}`).catch(() => {});
    await sw.evaluate("chrome.offscreen.closeDocument().catch(() => {})");
    await sw.evaluate(`new Promise((resolve) => { const req = indexedDB.open("anki-manga"); req.onerror = () => resolve(false);
      req.onsuccess = () => { const db = req.result; const names = [...db.objectStoreNames];
        if (!names.length) { db.close(); return resolve(true); }
        const tx = db.transaction(names, "readwrite"); names.forEach((n) => tx.objectStore(n).clear());
        tx.oncomplete = () => { db.close(); resolve(true); }; tx.onerror = () => { db.close(); resolve(false); }; }; })`);
    await sw.evaluate('chrome.storage.session.remove(["pageStatus", "missingHosts", "captureBlocked"])');
    // A fresh engine (models from the browser cache). Also before every site: closing a tab does not drop the work
    // its pages queued in the engine, and one site's backlog would show up as the next site's failure.
    const startEngine = async () => {
      await sw.evaluate('chrome.offscreen.closeDocument().catch(() => {}).then(() => chrome.storage.session.remove("modelStatus")).then(() => ensureOffscreen())');
      return waitFor(async () => {
        const st = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
        return st && ((st.state === "ready" && st.timings?.total != null) || st.state === "error") ? st : null;
      }, "the engine", realDownload ? 900000 : 300000);
    };
    const t0 = Date.now();
    const status = await startEngine();
    if (status.state === "error") throw new Error(`engine failed to start: ${status.error}`);
    const extId = await sw.evaluate("chrome.runtime.id");
    run.meta = {
      engine: `${status.ep}, mode ${status.mode}, settled in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      llm: llm.mode === "live" ? `live (budget ${llm.budget})` : llm.mode,
      grants: grantAll ? "all (as after every Allow …)" : "the site origins (as after Enable on this site)",
      models: realDownload ? "real host" : "local mirror",
    };
    console.log(`lab lane ${LANE}: ${sites.length} site(s), engine ${run.meta.engine}, llm ${run.meta.llm}`);
    ctx.panel = await openPanel(extId);

    for (const [i, site] of sites.entries()) {
      process.stdout.write(`== ${site.name} … `);
      if (i > 0) {
        const st = await startEngine();
        if (st.state === "error") throw new Error(`engine failed to restart: ${st.error}`);
      }
      // The steps reached so far stay in the report when the site runs out of time. A timed-out site cannot touch
      // the panel or the service worker any more (it would click into the next site's entries).
      const res = { name: site.name, steps: Object.fromEntries(STEPS.map((k) => [k, { ok: null }])), timings: {}, llm: [] };
      let dead = false;
      const fence = (cdp) => new Proxy(cdp, {
        get: (t, p) => (dead && (p === "evaluate" || p === "send") ? () => Promise.reject(new Error("site timed out")) : typeof t[p] === "function" ? t[p].bind(t) : t[p]),
      });
      const siteCtx = { ...ctx, panel: fence(ctx.panel), sw: fence(ctx.sw), tab: null };
      try {
        await Promise.race([
          runSite(site, siteCtx, res),
          sleep(SITE_TIMEOUT_MS).then(() => {
            throw new Error(`site took over ${SITE_TIMEOUT_MS / 1000} s`);
          }),
        ]);
      } catch (e) {
        dead = true;
        res.error = String(e.message || e);
      } finally {
        if (siteCtx.tab) {
          await fetch(`${base}/json/close/${siteCtx.tab.targetId}`).catch(() => {});
          siteCtx.tab.close();
        }
      }
      run.sites.push(res);
      console.log(STEPS.map((k) => `${k} ${res.steps[k].ok === true ? "✓" : res.steps[k].ok === false ? "✗" : "–"}`).join("  ") + (res.error ? `  (${res.error})` : ""));
      writeFileSync(join(OUT, "report.json"), JSON.stringify(run, null, 2));
    }
    if (headful) {
      console.log("\n--headful: the browser stays open. Press Enter to close it.");
      await new Promise((r) => createInterface({ input: process.stdin }).once("line", r));
    }
  } catch (e) {
    fatal = e;
  } finally {
    ctx.panel?.close();
    ctx.sw?.close();
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, sleep(10000)]);
    mirror.close();
    anki.server.close();
    await sleep(500);
  }

  run.meta.safety = `${safety.redirected} AnkiConnect request(s) redirected to the fake; blocked: ${safety.blocked.length ? safety.blocked.join(", ") : "none"}`;
  run.meta.explanations = summarizeLlm(safety.llm);
  const prevFile = existsSync(LATEST) ? JSON.parse(readFileSync(LATEST, "utf8")).report : null;
  const prev = prevFile && existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, "utf8")) : null;
  const diff = diffRuns(prev, run);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(OUT, "report.md"), renderMarkdown(run, diff));
  if (!fatal && run.sites.length) writeFileSync(LATEST, JSON.stringify({ report: join(OUT, "report.json") }));
  console.log(`\nreport: ${join(OUT, "report.md")}`);
  for (const d of diff) console.log(`  ${d.site}: ${d.step} ${d.from}→${d.to}${d.regression ? " (regression)" : ""}`);
  if (fatal) {
    console.error(`lab failed: ${fatal.message}`);
    return 1;
  }
  if (safety.blocked.length) {
    console.error(`lab failed: blocked requests (${safety.blocked.join(", ")})`);
    return 1;
  }
  return regressed(diff) ? 1 : 0;
}

function summarizeLlm(sources) {
  const by = {};
  for (const s of sources) by[s] = (by[s] || 0) + 1;
  return Object.entries(by).map(([k, n]) => `${k} ×${n}`).join(", ") || "none asked";
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`lab failed: ${e.message}`);
    process.exit(1);
  },
);
