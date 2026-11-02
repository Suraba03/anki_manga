// The panel's AnkiConnect session: one client, permission asked once, the note type created on the first card,
// and the known words of each deck fetched once (kept up to date as cards are added).
import { AnkiClient, AnkiError } from "../lib/anki.js";
import { shouldAskPermission } from "./logic.js";

const client = new AnkiClient((...args) => fetch(...args));
let permission = null;
let denied = false; // the user (or Anki's config) said no: only a user action asks again
let noteType = null;
const known = new Map(); // deck -> Promise<KnownWords>

// Resolves the client once Anki has accepted this extension's origin. The first call may show Anki's permission
// dialog. After a denial, calls from background events (tab changes, bubble clicks) fail at once without asking
// again; pass {userAction: true} from a button click to ask once more.
export function ankiReady({ userAction = false } = {}) {
  if (!shouldAskPermission({ denied, userAction })) return Promise.reject(new AnkiError("anki_origin_blocked"));
  if (permission) return permission;
  const p = client.requestPermission().then((r) => {
    denied = r?.permission !== "granted";
    if (denied) throw new AnkiError("anki_origin_blocked");
    return client;
  });
  permission = p;
  p.catch(() => {
    if (permission === p) permission = null; // Anki not running yet, or denied: a later (allowed) call asks again
  });
  return p;
}

// Same, and the "Manga Mining (anki_manga)" note type exists (created on first use). Called from "+".
export async function ankiForCards() {
  const c = await ankiReady({ userAction: true });
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

export async function deckNames(options) {
  return (await ankiReady(options)).deckNames();
}
