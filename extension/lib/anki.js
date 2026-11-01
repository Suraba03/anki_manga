// AnkiConnect client: decks, our note type, known words, adding cards. Port of helper anki.py; called straight
// from the extension (a chrome-extension:// origin, so Anki must allow it: see requestPermission).
import { KnownWords } from "./known.js";

export const NOTE_TYPE = "Manga Mining (anki_manga)";
export const FIELDS = [
  "Word",
  "Reading",
  "Meaning",
  "Sentence",
  "SentenceFurigana",
  "SentenceTranslation",
  "Explanation",
  "Picture",
  "Source",
];

const FRONT = `<div class="word">{{Word}}</div>
<div class="sentence">{{Sentence}}</div>`;

const BACK = `{{FrontSide}}
<hr id=answer>
<div class="reading">{{Reading}}</div>
<div class="meaning">{{Meaning}}</div>
<div class="furigana">{{SentenceFurigana}}</div>
<div class="translation">{{SentenceTranslation}}</div>
<div class="explanation">{{Explanation}}</div>
<div class="picture">{{Picture}}</div>
<div class="source">{{Source}}</div>`;

const CSS = `.card { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; font-size: 20px;
  text-align: center; color: #222; background: #fafaf7; line-height: 1.5; }
.word { font-size: 42px; margin: 12px 0; }
.sentence { font-size: 24px; }
.sentence b { color: #c0392b; }
.reading { font-size: 22px; color: #555; }
.meaning { font-size: 20px; margin-bottom: 10px; }
.furigana { font-size: 22px; } .furigana rt { color: #c0392b; font-size: 11px; }
.translation { font-style: italic; color: #555; margin: 8px 0; }
.explanation { text-align: left; font-size: 15px; max-width: 560px; margin: 10px auto;
  border-left: 3px solid #f5a524; padding-left: 10px; }
.picture img { max-width: 100%; max-height: 420px; border-radius: 6px; margin-top: 10px; }
.source { font-size: 12px; color: #999; margin-top: 8px; }
.nightMode .card, .card.nightMode { background: #1e1e1e; color: #eee; }`;

const BATCH = 500;
const DEFAULT_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120000; // Anki waits for the user to answer a dialog
const ORIGIN_REFUSED = /origin|permission|forbidden/i;

// kind: anki_unreachable | anki_origin_blocked | duplicate | anki_error
export class AnkiError extends Error {
  constructor(kind, detail = "") {
    super(detail || kind);
    this.kind = kind;
  }
}

export class AnkiClient {
  constructor(fetch, url = DEFAULT_URL, { timeoutMs = DEFAULT_TIMEOUT_MS, permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS, apiKey = "" } = {}) {
    this._fetch = fetch;
    this._url = url;
    this._timeoutMs = timeoutMs;
    this._permissionTimeoutMs = permissionTimeoutMs;
    this._apiKey = apiKey;
  }

  async _call(action, params = {}, timeoutMs = this._timeoutMs) {
    const request = { action, version: 6, params };
    if (this._apiKey) request.key = this._apiKey;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let status;
    let data;
    try {
      const resp = await this._fetch(this._url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      status = resp.status;
      if (status === 403) throw new AnkiError("anki_origin_blocked");
      data = await resp.json();
    } catch (e) {
      if (e instanceof AnkiError) throw e;
      throw new AnkiError("anki_unreachable", String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
    }
    if (data?.error) {
      const msg = String(data.error);
      if (msg.includes("duplicate")) throw new AnkiError("duplicate");
      if (ORIGIN_REFUSED.test(msg)) throw new AnkiError("anki_origin_blocked", msg);
      throw new AnkiError("anki_error", msg);
    }
    return data?.result;
  }

  // Asks Anki (a dialog on first use) to allow this extension's origin. -> {permission, requireApikey?, version?}
  requestPermission() {
    return this._call("requestPermission", {}, this._permissionTimeoutMs);
  }

  async deckNames() {
    return (await this._call("deckNames")).slice().sort();
  }

  async ensureNoteType() {
    if ((await this._call("modelNames")).includes(NOTE_TYPE)) return false;
    await this._call("createModel", {
      modelName: NOTE_TYPE,
      inOrderFields: FIELDS,
      css: CSS,
      isCloze: false,
      cardTemplates: [{ Name: "Recognition", Front: FRONT, Back: BACK }],
    });
    return true;
  }

  async knownWords(deck) {
    const query = `deck:"${deck.replace(/[\\"]/g, "\\$&")}"`;
    const ids = await this._call("findNotes", { query });
    const notes = [];
    for (let i = 0; i < ids.length; i += BATCH) notes.push(...(await this._call("notesInfo", { notes: ids.slice(i, i + BATCH) })));
    return KnownWords.fromNotes(notes, NOTE_TYPE);
  }

  addCard(deck, fields, pictureBase64, filename) {
    const note = {
      deckName: deck,
      modelName: NOTE_TYPE,
      fields,
      options: { allowDuplicate: false, duplicateScope: "deck" },
      tags: ["anki_manga"],
    };
    if (pictureBase64) note.picture = [{ data: pictureBase64, filename, fields: ["Picture"] }];
    return this._call("addNote", { note });
  }
}
