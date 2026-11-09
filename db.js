/* db.js — tiny IndexedDB wrapper storing song files for offline use, plus an
   "outbox" of edits waiting to be uploaded to Dropbox (see save-queue.js). */

const SongDB = (() => {
  const DB_NAME = 'chordbook';
  const DB_VERSION = 2;
  const STORE = 'songs';
  const OUTBOX = 'outbox';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'path' });
          store.createIndex('name', 'name', { unique: false });
        }
        // v2: pending saves, keyed by song path. One entry per song — a later edit
        // replaces an earlier one but keeps the rev it was originally based on.
        if (!db.objectStoreNames.contains(OUTBOX)) {
          db.createObjectStore(OUTBOX, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => {
        // If a newer version of the app opens the DB in another tab, let it upgrade.
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function write(storeName, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function read(storeName, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = fn(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const putSong = (record) => write(STORE, (s) => s.put(record));
  const deleteSong = (path) => write(STORE, (s) => s.delete(path));
  const getAllSongs = async () => (await read(STORE, (s) => s.getAll())) || [];
  const getSong = async (path) => (await read(STORE, (s) => s.get(path))) || null;
  const clearAll = () => write(STORE, (s) => s.clear());

  const putOutbox = (entry) => write(OUTBOX, (s) => s.put(entry));
  const deleteOutbox = (path) => write(OUTBOX, (s) => s.delete(path));
  const getOutbox = async () => (await read(OUTBOX, (s) => s.getAll())) || [];
  const getOutboxEntry = async (path) => (await read(OUTBOX, (s) => s.get(path))) || null;
  const clearOutbox = () => write(OUTBOX, (s) => s.clear());

  async function estimateUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return est;
    }
    return null;
  }

  return {
    putSong, deleteSong, getAllSongs, getSong, clearAll, estimateUsage,
    putOutbox, deleteOutbox, getOutbox, getOutboxEntry, clearOutbox,
  };
})();
