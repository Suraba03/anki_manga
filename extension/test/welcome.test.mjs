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

test("welcome page: an optional Anki block (AnkiConnect code, the panel's real button, the README's Anki section)", () => {
  assert.match(text, /Optional: save words to Anki/);
  assert.match(text, /work without Anki/);
  assert.match(text, /Tools → Add-ons → Get Add-ons…/);
  assert.match(text, /2055492159/);
  assert.match(text, /Restart Anki and keep it open/);
  const connect = panelHtml.match(/id="anki-connect"[^>]*>([^<]+)</)[1];
  assert.ok(text.includes(`“${connect}”`), `mentions “${connect}”`);
  assert.match(text, /accept the prompt in Anki/);
  assert.match(text, /deck/);
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /^## Anki and AnkiConnect$/m, "the link's anchor exists");
  assert.match(html, /<a href="https:\/\/apps\.ankiweb\.net\/" target="_blank" rel="noopener">Anki desktop<\/a>/, "the official download page");
  assert.match(html, /<a href="https:\/\/github\.com\/Suraba03\/anki_manga#anki-and-ankiconnect" target="_blank" rel="noopener">/);
  assert.ok(html.indexOf("Optional: save words to Anki") > html.indexOf('id="next-title"'), "after the While you wait steps");
});
