// Persistence for the library: IndexedDB in the browser, an in-memory Map in tests.
//
// Stores
//   tracks     track records (metadata, cues, beat grid)
//   playlists  playlist records
//   audio      the audio files themselves (Blob), keyed by track id
//   analysis   cached waveform + BPM analysis, keyed by track id
//   settings   app settings, key/value

const STORES = ['tracks', 'playlists', 'audio', 'analysis', 'settings'];

export class IdbStore {
  constructor(name = 'tdjablet') {
    this.name = name;
    this.db = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this);
      };
      req.onerror = () => reject(req.error);
    });
  }

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      const req = fn(os);
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  get(store, key) {
    return this._tx(store, 'readonly', (os) => os.get(key));
  }

  put(store, key, value) {
    return this._tx(store, 'readwrite', (os) => os.put(value, key));
  }

  /** Write many [key, value] pairs in one transaction. */
  putMany(store, entries) {
    return this._tx(store, 'readwrite', (os) => {
      for (const [k, v] of entries) os.put(v, k);
      return null;
    });
  }

  delete(store, key) {
    return this._tx(store, 'readwrite', (os) => os.delete(key));
  }

  clear(store) {
    return this._tx(store, 'readwrite', (os) => os.clear());
  }

  getAll(store) {
    return this._tx(store, 'readonly', (os) => os.getAll());
  }
}

export class MemoryStore {
  constructor() {
    this.data = new Map(STORES.map((s) => [s, new Map()]));
  }
  async open() {
    return this;
  }
  async get(store, key) {
    return this.data.get(store).get(key);
  }
  async put(store, key, value) {
    this.data.get(store).set(key, value);
  }
  async putMany(store, entries) {
    for (const [k, v] of entries) this.data.get(store).set(k, v);
  }
  async delete(store, key) {
    this.data.get(store).delete(key);
  }
  async clear(store) {
    this.data.get(store).clear();
  }
  async getAll(store) {
    return [...this.data.get(store).values()];
  }
}
