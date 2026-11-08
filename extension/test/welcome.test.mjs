// The welcome tab opened on install: static copy and wiring (the live line itself is modelStatusLine, tested in panel-logic).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const html = read("welcome/welcome.html");
const js = read("welcome/welcome.js");
const panelHtml = read("panel/panel.html");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("welcome page: live status line driven by the panel's modelStatusLine (not a copy of it)", () => {
  assert.match(html, /<script type="module" src="welcome\.js"><\/script>/);
  assert.match(html, /id="status"/);
  assert.match(js, /import \{[^}]*\bmodelStatusLine\b[^}]*\} from "\.\.\/panel\/logic\.js"/);
  assert.match(js, /chrome\.storage\.session\.onChanged/);
  assert.doesNotMatch(js, /Downloading models/, "the copy lives in panel/logic.js only");
});

test("welcome page: why the download happens once, and what is and is not sent", () => {
  assert.match(text, /OCR runs on your computer/);
  assert.match(text, /about 340 MB with WebGPU or about 190 MB on the CPU/);
  assert.match(text, /once/);
  assert.match(text, /never uploads page images/);
  assert.doesNotMatch(text, /never leave your computer/);
  assert.match(text, /Explanations send the text of a bubble you click/);
  assert.match(text, /unless you turn them Off/);
});

test("welcome page: the next step names the panel's real button", () => {
  const label = panelHtml.match(/id="site-toggle"[^>]*>([^<]+)</)[1];
  assert.ok(text.includes(`“${label}”`), `mentions “${label}”`);
  assert.match(text, /Open a manga page/);
});

test("welcome page: English, shared look, no inline script", () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /href="\.\.\/panel\/panel\.css"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "MV3 pages allow no inline script");
});
