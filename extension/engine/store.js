// IndexedDB cache for pages, OCR texts, page images and explanations (port of the helper's store.py).
// Page ids are the hex SHA-256 of the raw image bytes, so the same picture is the same page everywhere.

const MAX_PAGE_IMAGES = 300;
const EXPLANATION_VERSION = 1; // bump together with the prompt: old explanations stop matching
const STORES = ["pages", "texts", "images", "explanations"];

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// indexedDB: an IDBFactory (the global one, or fake-indexeddb's in tests).
export async function openStore(indexedDB, { name = "anki-manga", maxImages = MAX_PAGE_IMAGES } = {}) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("pages", { keyPath: "id" });
      d.createObjectStore("texts", { keyPath: "id" }); // one record per page: {id, texts: {bubbleId: text}}
      d.createObjectStore("images", { keyPath: "id" }).createIndex("seq", "seq");
      d.createObjectStore("explanations", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Runs fn(stores) in one transaction and resolves with its result once the transaction has committed.
  const tx = (names, mode, fn) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
      let result;
      Promise.resolve(fn(stores)).then((r) => (result = r), reject);
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error);
    });

  return {
    pageIdFor: sha256Hex,

    savePage: (id, width, height, bubbles) =>
      tx(["pages"], "readwrite", ({ pages }) => wrap(pages.put({ id, width, height, bubbles }))),

    // Bubbles carry their OCR text, or null when it is not known yet.
    getPage: (id) =>
      tx(["pages", "texts"], "readonly", async ({ pages, texts }) => {
        const page = await wrap(pages.get(id));
        if (!page) return null;
        const known = (await wrap(texts.get(id)))?.texts || {};
        return {
          width: page.width,
          height: page.height,
          bubbles: page.bubbles.map((b) => ({ ...b, text: known[b.id] ?? null })),
        };
      }),

    setText: (id, bubbleId, text) =>
      tx(["texts"], "readwrite", async ({ texts }) => {
        const rec = (await wrap(texts.get(id))) || { id, texts: {} };
        rec.texts[bubbleId] = text;
        await wrap(texts.put(rec));
      }),

    getText: (id, bubbleId) =>
      tx(["texts"], "readonly", async ({ texts }) => (await wrap(texts.get(id)))?.texts[bubbleId] ?? null),

    // Keeps the newest maxImages images; saving an id again makes it the newest.
    saveImage: (id, bytes) =>
      tx(["images"], "readwrite", async ({ images }) => {
        const last = await wrap(images.index("seq").openKeyCursor(null, "prev"));
        await wrap(images.put({ id, seq: (last?.key ?? 0) + 1, bytes }));
        const excess = (await wrap(images.count())) - maxImages;
        if (excess <= 0) return;
        const doomed = [];
        await new Promise((resolve, reject) => {
          const req = images.index("seq").openKeyCursor();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const c = req.result;
            if (!c || doomed.length >= excess) return resolve();
            doomed.push(c.primaryKey);
            c.continue();
          };
        });
        for (const k of doomed) images.delete(k);
      }),

    loadImage: (id) => tx(["images"], "readonly", async ({ images }) => (await wrap(images.get(id)))?.bytes ?? null),

    countImages: () => tx(["images"], "readonly", ({ images }) => wrap(images.count())),

    explanationKey: (text) => sha256Hex(new TextEncoder().encode(`${EXPLANATION_VERSION}\n${text.normalize("NFKC").trim()}`)),

    getExplanation: (key) =>
      tx(["explanations"], "readonly", async ({ explanations }) => (await wrap(explanations.get(key)))?.value ?? null),

    putExplanation: (key, value) => tx(["explanations"], "readwrite", ({ explanations }) => wrap(explanations.put({ key, value }))),

    // "Delete models and caches" (eng:clear).
    clear: () => tx(STORES, "readwrite", (s) => Promise.all(STORES.map((n) => wrap(s[n].clear())))),
  };
}
