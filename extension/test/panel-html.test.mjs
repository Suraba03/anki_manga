import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../panel/panel.html", import.meta.url), "utf8");

test("About carries the JMdict attribution and the licence links", () => {
  assert.match(html, /Dictionary: JMdict by the Electronic Dictionary Research and Development Group \(EDRDG\), used under CC BY-SA 4\.0/);
  assert.match(html, /href="https:\/\/www\.edrdg\.org\/edrdg\/licence\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/scriptin\/jmdict-simplified"/);
});
