import test from "node:test";
import assert from "node:assert/strict";
import { AnkiClient, AnkiError, FIELDS, NOTE_TYPE } from "../lib/anki.js";

const ok = (result) => ({ result, error: null });
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

function client(results, extra = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, init, body });
    return results(body);
  };
  return { sent, c: new AnkiClient(fetch, undefined, extra) };
}
const rejects = (p, kind, message) =>
  assert.rejects(p, (e) => e instanceof AnkiError && e.kind === kind && (message === undefined || e.message === message));

test("ensureNoteType creates the model when missing", async () => {
  const { sent, c } = client((b) => json(b.action === "modelNames" ? ok(["Basic"]) : ok({})));
  assert.equal(await c.ensureNoteType(), true);
  const create = sent.find((s) => s.body.action === "createModel").body;
  assert.equal(create.params.modelName, NOTE_TYPE);
  assert.deepEqual(create.params.inOrderFields, FIELDS);
  assert.equal(create.version, 6);
  assert.equal(create.params.isCloze, false);
  assert.equal(create.params.cardTemplates[0].Name, "Recognition");
  assert.ok(create.params.cardTemplates[0].Front.includes("{{Sentence}}"));
  assert.ok(create.params.cardTemplates[0].Back.includes("{{FrontSide}}"));
  assert.ok(create.params.css.includes(".nightMode"));
  assert.equal(sent[0].url, "http://127.0.0.1:8765");
  assert.equal(sent[0].init.method, "POST");
});

test("ensureNoteType is a no-op when present", async () => {
  const { sent, c } = client(() => json(ok(["Basic", NOTE_TYPE])));
  assert.equal(await c.ensureNoteType(), false);
  assert.ok(!sent.some((s) => s.body.action === "createModel"));
});

test("deckNames returns sorted names", async () => {
  const { c } = client(() => json(ok(["b", "a", "Default"])));
  assert.deepEqual(await c.deckNames(), ["Default", "a", "b"]);
});

test("addCard payload", async () => {
  const { sent, c } = client(() => json(ok(1234)));
  const id = await c.addCard("manga mining", { Word: "角度" }, "QUJD", "pic.jpg");
  assert.equal(id, 1234);
  const { note } = sent[0].body.params;
  assert.equal(sent[0].body.action, "addNote");
  assert.equal(note.deckName, "manga mining");
  assert.equal(note.modelName, NOTE_TYPE);
  assert.deepEqual(note.fields, { Word: "角度" });
  assert.deepEqual(note.picture, [{ data: "QUJD", filename: "pic.jpg", fields: ["Picture"] }]);
  assert.equal(note.options.duplicateScope, "deck");
  assert.equal(note.options.allowDuplicate, false);
  assert.deepEqual(note.tags, ["anki_manga"]);
});

test("addCard without a picture omits the picture key", async () => {
  const { sent, c } = client(() => json(ok(1)));
  await c.addCard("d", { Word: "x" }, null, "p.jpg");
  assert.ok(!("picture" in sent[0].body.params.note));
});

test("knownWords queries the deck and builds the index", async () => {
  const { sent, c } = client((b) =>
    json(
      b.action === "findNotes"
        ? ok([1, 2])
        : ok([
            { modelName: "Basic", fields: { Front: { value: "道具", order: 0 } } },
            { modelName: NOTE_TYPE, fields: { Word: { value: "角度", order: 0 } } },
          ]),
    ),
  );
  const k = await c.knownWords("manga mining");
  assert.equal(sent[0].body.params.query, 'deck:"manga mining"');
  assert.ok(k.isKnown("道具", "どうぐ") && k.isKnown("角度", "かくど"));
});

test("knownWords escapes quotes and backslashes in the deck name", async () => {
  const { sent, c } = client(() => json(ok([])));
  await c.knownWords('my "quoted" deck');
  assert.equal(sent[0].body.params.query, 'deck:"my \\"quoted\\" deck"');
  const again = client(() => json(ok([])));
  await again.c.knownWords("a\\b");
  assert.equal(again.sent[0].body.params.query, 'deck:"a\\\\b"');
});

test("knownWords fetches notesInfo in batches of 500", async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
  const { sent, c } = client((b) => json(b.action === "findNotes" ? ok(ids) : ok([])));
  await c.knownWords("d");
  const infos = sent.filter((s) => s.body.action === "notesInfo").map((s) => s.body.params.notes.length);
  assert.deepEqual(infos, [500, 500, 1]);
});

test("network failure maps to anki_unreachable", async () => {
  const c = new AnkiClient(async () => {
    throw new TypeError("Failed to fetch");
  });
  await rejects(c.deckNames(), "anki_unreachable");
});

test("non-JSON response maps to anki_unreachable", async () => {
  const c = new AnkiClient(async () => new Response("<html>", { status: 200 }));
  await rejects(c.deckNames(), "anki_unreachable");
});

test("a hanging request times out as anki_unreachable", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const c = new AnkiClient(hang, undefined, { timeoutMs: 20 });
  await rejects(c.deckNames(), "anki_unreachable");
});

test("duplicate error", async () => {
  const { c } = client(() => json({ result: null, error: "cannot create note because it is a duplicate" }));
  await rejects(c.addCard("d", { Word: "x" }, null, "p.jpg"), "duplicate");
});

test("other AnkiConnect errors become anki_error and keep the message", async () => {
  const { c } = client(() => json({ result: null, error: "deck was not found: nope" }));
  await rejects(c.addCard("nope", { Word: "x" }, null, "p.jpg"), "anki_error", "deck was not found: nope");
});

test("HTTP 403 maps to anki_origin_blocked on any call", async () => {
  const c = new AnkiClient(async () => new Response("forbidden", { status: 403 }));
  await rejects(c.deckNames(), "anki_origin_blocked");
  await rejects(c.ensureNoteType(), "anki_origin_blocked");
  await rejects(c.knownWords("d"), "anki_origin_blocked");
  await rejects(c.addCard("d", {}, null, "p.jpg"), "anki_origin_blocked");
});

test("an origin or permission error string maps to anki_origin_blocked", async () => {
  for (const error of ["origin not allowed", "Permission denied", "Forbidden"]) {
    const { c } = client(() => json({ result: null, error }));
    await rejects(c.deckNames(), "anki_origin_blocked");
  }
});

test("requestPermission granted and denied", async () => {
  const granted = client(() => json(ok({ permission: "granted", requireApikey: false, version: 6 })));
  assert.deepEqual(await granted.c.requestPermission(), { permission: "granted", requireApikey: false, version: 6 });
  assert.equal(granted.sent[0].body.action, "requestPermission");
  assert.equal(granted.sent[0].body.version, 6);
  const denied = client(() => json(ok({ permission: "denied" })));
  assert.deepEqual(await denied.c.requestPermission(), { permission: "denied" });
});

test("requestPermission reports network failure", async () => {
  const c = new AnkiClient(async () => {
    throw new TypeError("refused");
  });
  await rejects(c.requestPermission(), "anki_unreachable");
});

test("apiKey is sent as key only when set", async () => {
  const withKey = client(() => json(ok([])), { apiKey: "secret" });
  await withKey.c.deckNames();
  assert.equal(withKey.sent[0].body.key, "secret");
  const without = client(() => json(ok([])));
  await without.c.deckNames();
  assert.ok(!("key" in without.sent[0].body));
});

test("requestPermission is not cut off at the normal timeout but is at its own", async () => {
  const slowGrant = (delayMs) => (url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(json(ok({ permission: "granted" }))), delayMs);
      init.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  // answered after 60 ms: past timeoutMs (20) but within permissionTimeoutMs (200)
  const patient = new AnkiClient(slowGrant(60), undefined, { timeoutMs: 20, permissionTimeoutMs: 200 });
  assert.deepEqual(await patient.requestPermission(), { permission: "granted" });
  // the same delay on a normal call is cut off
  await rejects(new AnkiClient(slowGrant(60), undefined, { timeoutMs: 20, permissionTimeoutMs: 200 }).deckNames(), "anki_unreachable");
  // never answered: aborted at the permission timeout
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  await rejects(new AnkiClient(hang, undefined, { timeoutMs: 20, permissionTimeoutMs: 50 }).requestPermission(), "anki_unreachable");
});
