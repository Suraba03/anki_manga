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
  assert.match(html, /<p id="deck-target" class="deck-target"[^>]*><\/p>\s*<main id="entries">/);
});
