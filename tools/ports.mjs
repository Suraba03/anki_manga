// Ports of the browser harnesses (tools/e2e, tools/demo, tools/compat). A second checkout sets
// ANKI_MANGA_PORT_OFFSET (e.g. 100) so its Chrome, local servers and fake AnkiConnect never collide with the first's.
// The real AnkiConnect port (8765) is not shifted: the harnesses only ever redirect away from it.
const raw = process.env.ANKI_MANGA_PORT_OFFSET ?? "0";
if (!/^\d+$/.test(raw) || Number(raw) > 1000) {
  throw new Error(`ANKI_MANGA_PORT_OFFSET must be a whole number from 0 to 1000, got "${raw}"`);
}
export const PORT_OFFSET = Number(raw);
export const port = (base) => base + PORT_OFFSET;
