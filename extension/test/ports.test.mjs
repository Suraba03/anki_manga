// tools/ports.mjs: the browser harnesses of two checkouts can run at once when one sets ANKI_MANGA_PORT_OFFSET.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ports = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "ports.mjs");

function portOf(base, offset) {
  const env = { ...process.env };
  delete env.ANKI_MANGA_PORT_OFFSET;
  if (offset !== undefined) env.ANKI_MANGA_PORT_OFFSET = offset;
  const code = `import(${JSON.stringify(ports)}).then((m) => console.log(m.port(${base})))`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
}

test("port() is the base port without ANKI_MANGA_PORT_OFFSET", () => {
  assert.equal(portOf(9333).stdout.trim(), "9333");
});

test("port() adds ANKI_MANGA_PORT_OFFSET", () => {
  assert.equal(portOf(9333, "100").stdout.trim(), "9433");
  assert.equal(portOf(8766, "100").stdout.trim(), "8866");
});

test("a bad ANKI_MANGA_PORT_OFFSET fails loudly instead of reusing the other checkout's ports", () => {
  for (const bad of ["abc", "-5", "2.5", "5000"]) {
    const r = portOf(9333, bad);
    assert.notEqual(r.status, 0, `offset ${bad} should fail`);
    assert.match(r.stderr, /ANKI_MANGA_PORT_OFFSET/);
  }
});
