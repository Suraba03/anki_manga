// The panel's AnkiConnect session: one client, permission asked once, the note type created on the first card,
// and the known words of each deck fetched once (kept up to date as cards are added).
import { AnkiClient, AnkiError } from "../lib/anki.js";

const client = new AnkiClient((...args) => fetch(...args));
let permission = null;
let noteType = null;
const known = new Map(); // deck -> Promise<KnownWords>

// Resolves the client once Anki has accepted this extension's origin. The first call may show Anki's permission dialog.
export function ankiReady() {
  permission ||= client.requestPermission().then((r) => {
    if (r?.permission !== "granted") throw new AnkiError("anki_origin_blocked");
    return client;
  });
  permission.catch(() => {
    permission = null; // Anki not running yet, or the user said no: ask again next time
  });
  return permission;
}

// Same, and the "Manga Mining (anki_manga)" note type exists (created on first use).
export async function ankiForCards() {
  const c = await ankiReady();
  noteType ||= c.ensureNoteType();
  noteType.catch(() => {
    noteType = null;
  });
  await noteType;
  return c;
}

export function knownWords(deck) {
  if (!known.has(deck)) {
    const p = ankiReady().then((c) => c.knownWords(deck));
    p.catch(() => known.delete(deck));
    known.set(deck, p);
  }
  return known.get(deck);
}

export const forgetKnown = (deck) => known.delete(deck);

export async function deckNames() {
  return (await ankiReady()).deckNames();
}
