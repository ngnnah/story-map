// Local persistence. The map image never leaves the machine: it is read from
// the user's disk, kept as a Blob in IndexedDB keyed by book id, and handed to
// the page as an object URL.
//
// Not pure and not unit tested — everything here is a thin wrapper over a
// browser API, and the interesting logic lives in the pure modules.

const DB_NAME = 'story-map';
const DB_VERSION = 1;
const STORE = 'maps';
const PREFIX = 'story-map:';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve(req ? req.result : undefined);
      }),
  );
}

/** Store a map image for a book. Replaces any previous one. */
export async function putImage(bookId, blob) {
  return run('readwrite', (store) => store.put(blob, bookId));
}

/** The stored Blob for a book, or undefined. Never throws — returns undefined. */
export async function getImage(bookId) {
  try {
    return await run('readonly', (store) => store.get(bookId));
  } catch {
    return undefined;                 // private window, blocked storage, etc.
  }
}

export async function delImage(bookId) {
  try {
    return await run('readwrite', (store) => store.delete(bookId));
  } catch {
    return undefined;
  }
}

// --- small preferences -----------------------------------------------------
// localStorage can throw or come back empty (private window, cleared site
// data), so every read and write is wrapped and the app works without it.

export function pref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* nothing worth doing; the app is fully usable without persistence */
  }
}
