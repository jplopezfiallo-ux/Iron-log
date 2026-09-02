// db.js — IndexedDB wrapper for Iron Log
// Schema is versioned so future feature updates can migrate data safely.

const DB_NAME = 'iron-log';
const DB_VERSION = 1;
const SCHEMA_VERSION = 1; // app-level record shape version, independent of IDB version

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('profiles')) {
        const store = db.createObjectStore('profiles', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }

      if (!db.objectStoreNames.contains('exercises')) {
        const store = db.createObjectStore('exercises', { keyPath: 'id' });
        store.createIndex('name', 'name');
      }

      if (!db.objectStoreNames.contains('routines')) {
        const store = db.createObjectStore('routines', { keyPath: 'id' });
        store.createIndex('profileId', 'profileId');
      }

      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('profileId', 'profileId');
        store.createIndex('date', 'date');
      }

      // Individual set records — one row per set. This is what makes
      // per-exercise trend charts, volume calcs, and PR detection possible
      // without re-deriving from nested session data.
      if (!db.objectStoreNames.contains('sets')) {
        const store = db.createObjectStore('sets', { keyPath: 'id' });
        store.createIndex('profileId', 'profileId');
        store.createIndex('exerciseId', 'exerciseId');
        store.createIndex('sessionId', 'sessionId');
        store.createIndex('date', 'date');
        store.createIndex('profileExercise', ['profileId', 'exerciseId']);
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  async put(storeName, value) {
    const t = await tx([storeName], 'readwrite');
    const store = t.objectStore(storeName);
    await reqToPromise(store.put(value));
    return value;
  },

  async get(storeName, id) {
    const t = await tx([storeName]);
    return reqToPromise(t.objectStore(storeName).get(id));
  },

  async getAll(storeName) {
    const t = await tx([storeName]);
    return reqToPromise(t.objectStore(storeName).getAll());
  },

  async getAllByIndex(storeName, indexName, value) {
    const t = await tx([storeName]);
    const idx = t.objectStore(storeName).index(indexName);
    return reqToPromise(idx.getAll(value));
  },

  async delete(storeName, id) {
    const t = await tx([storeName], 'readwrite');
    await reqToPromise(t.objectStore(storeName).delete(id));
  },

  async clear(storeName) {
    const t = await tx([storeName], 'readwrite');
    await reqToPromise(t.objectStore(storeName).clear());
  },
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ---- Default exercise library (seeded on first run) ----
const DEFAULT_EXERCISES = [
  { name: 'Bench Press', icon: 'bench-press' },
  { name: 'Lat Pulldown', icon: 'lat-pulldown' },
  { name: 'Machine Row', icon: 'machine-row' },
  { name: 'Machine Shoulder Press', icon: 'machine-shoulder-press' },
  { name: 'Preacher Curl', icon: 'preacher-curl' },
  { name: 'Pec Deck', icon: 'pec-deck' },
  { name: 'Triceps Extension', icon: 'triceps-extension' },
];

async function seedIfEmpty() {
  const meta = await DB.get('meta', 'seeded');
  if (meta && meta.value) return;

  for (const ex of DEFAULT_EXERCISES) {
    await DB.put('exercises', {
      id: uid(),
      name: ex.name,
      icon: ex.icon,
      isPlaceholderIcon: false,
      createdAt: Date.now(),
    });
  }

  await DB.put('meta', { key: 'seeded', value: true });
  await DB.put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
}

// ---- Export / Import ----
async function exportAllData() {
  const [profiles, exercises, routines, sessions, sets] = await Promise.all([
    DB.getAll('profiles'),
    DB.getAll('exercises'),
    DB.getAll('routines'),
    DB.getAll('sessions'),
    DB.getAll('sets'),
  ]);
  return {
    app: 'iron-log',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { profiles, exercises, routines, sessions, sets },
  };
}

async function importAllData(payload, { replace = false } = {}) {
  if (!payload || !payload.data) throw new Error('Invalid backup file');
  const { profiles = [], exercises = [], routines = [], sessions = [], sets = [] } = payload.data;

  if (replace) {
    await Promise.all(
      ['profiles', 'exercises', 'routines', 'sessions', 'sets'].map((s) => DB.clear(s))
    );
  }

  for (const p of profiles) await DB.put('profiles', p);
  for (const e of exercises) await DB.put('exercises', e);
  for (const r of routines) await DB.put('routines', r);
  for (const s of sessions) await DB.put('sessions', s);
  for (const s of sets) await DB.put('sets', s);
}

window.IronLogDB = { DB, uid, seedIfEmpty, exportAllData, importAllData, SCHEMA_VERSION };
