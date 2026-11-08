import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../panel/panel.html", import.meta.url), "utf8");

test("About carries the JMdict attribution and the licence links", () => {
  assert.match(html, /Dictionary: JMdict by the Electronic Dictionary Research and Development Group \(EDRDG\), used under CC BY-SA 4\.0/);
  assert.match(html, /href="https:\/\/www\.edrdg\.org\/edrdg\/licence\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/scriptin\/jmdict-simplified"/);
});

const css = readFileSync(new URL("../panel/panel.css", import.meta.url), "utf8");

test("the empty panel does not mention Yomitan (we can't tell whether it is installed)", () => {
  const empty = html.match(/<p id="empty"[^>]*>([\s\S]*?)<\/p>/)[1];
  assert.doesNotMatch(empty, /Yomitan/i);
  assert.match(empty, /<b>Click<\/b> a bubble/);
  assert.match(empty, /Click a word in the sentence for its dictionary entry/);
});

test("an added card is green at full opacity, not greyed like a disabled button", () => {
  const rules = (sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim().startsWith(sel))).map(([, , body]) => body).join(";");
  for (const row of [".card.added", ".dict-entry.added"]) {
    const body = rules(`${row} button`);
    assert.match(body, /var\(--ok\)/, `${row} button uses the success colour`);
    assert.match(body, /cursor:\s*default/, `${row} button does not look clickable`);
    assert.doesNotMatch(rules(row + " ") + rules(row + "{"), /opacity/, `${row} is not faded`);
  }
});

test("deck: Settings has buttons to confirm or create the deck; the line naming it sits right above the entries", () => {
  assert.match(html, /<button id="deck-use" class="btn" type="button" hidden>/);
  assert.match(html, /<button id="deck-create" class="btn" type="button" hidden>Create “manga mining”<\/button>/);
  assert.match(html, /<button id="deck-target" class="deck-target" type="button" title="[^"]*"><\/button>\s*<main id="entries">/);
});

test("deck: the deck line is a real button, styled as small text", () => {
  const rule = css.match(/\.deck-target\s*\{([^}]*)\}/)[1];
  assert.match(rule, /background:\s*none/);
  assert.match(rule, /border:\s*0|border:\s*none/);
  assert.match(rule, /font-size:\s*12px/);
});

test("deck: the select is named by its label alone; the state is announced politely", () => {
  assert.match(html, /<label for="deck">Anki deck for this site<\/label>\s*<select id="deck">/);
  assert.match(html, /<span id="deck-state" class="hint" aria-live="polite">/);
  assert.doesNotMatch(html, /<label[^>]*>[^<]*(?:<(?!\/label)[^>]*>[^<]*)*<select id="deck"/, "the select is not nested in a label");
});

test("Explanations: Free, own key and Off radios; a hint element and a delete-key button", () => {
  const values = [...html.matchAll(/<input type="radio" name="llm-mode" value="(\w+)">/g)].map((m) => m[1]);
  assert.deepEqual(values, ["free", "own", "off"]);
  assert.match(html, /<input type="radio" name="llm-mode" value="off"> Off — nothing is sent<\/label>/);
  assert.match(html, /<button id="delete-key" class="btn" type="button" hidden>Delete saved key<\/button>/);
  assert.match(html, /<p id="llm-hint" class="hint"><\/p>/);
  assert.doesNotMatch(html, /Only the text of the bubble you click is sent/);
});
