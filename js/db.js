// db.js — IndexedDB wrapper for Iron Log
// Schema is versioned so future feature updates can migrate data safely.
// Wrapped in an IIFE so none of these names leak into the shared global
// script scope (db.js and app.js are separate <script> tags that share
// one top-level scope — only window.IronLogDB is exposed on purpose).
(function () {
'use strict';


const DB_NAME = 'iron-log';
const DB_VERSION = 1;
const SCHEMA_VERSION = 3; // app-level record shape version, independent of IDB version
const DATA_STORES = ['profiles', 'exercises', 'routines', 'sessions', 'sets'];
const { EXERCISE_CATEGORIES, TRACKING_TYPES } = window.IronLogDomain;
const VALID_CATEGORY_IDS = new Set(EXERCISE_CATEGORIES.map((category) => category.id));
const VALID_TRACKING_TYPES = new Set(TRACKING_TYPES.map((type) => type.id));

// ---- Unit conversion (canonical storage is always lbs) ----
const LBS_PER_KG = 2.20462;
function lbsToKg(lbs) { return lbs / LBS_PER_KG; }
function kgToLbs(kg) { return kg * LBS_PER_KG; }
// Convert a stored lbs value to whatever unit is currently displayed.
function toDisplayWeight(lbsValue, unit) {
  return unit === 'kg' ? lbsToKg(lbsValue) : lbsValue;
}
// Convert a value typed in the currently displayed unit back to lbs for storage.
function toStoredLbs(displayValue, unit) {
  return unit === 'kg' ? kgToLbs(displayValue) : displayValue;
}

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
  { name: 'Bench Press', icon: 'bench-press', trackingType: 'weighted', category: 'chest' },
  { name: 'Lat Pulldown', icon: 'lat-pulldown', trackingType: 'weighted', category: 'back' },
  { name: 'Machine Row', icon: 'machine-row', trackingType: 'weighted', category: 'back' },
  { name: 'Machine Shoulder Press', icon: 'machine-shoulder-press', trackingType: 'weighted', category: 'shoulders' },
  { name: 'Preacher Curl', icon: 'preacher-curl', trackingType: 'weighted', category: 'arms' },
  { name: 'Pec Deck', icon: 'pec-deck', trackingType: 'weighted', category: 'chest' },
  { name: 'Triceps Extension', icon: 'triceps-extension', trackingType: 'weighted', category: 'arms' },
  { name: 'Romanian Deadlift', icon: 'romanian-deadlift', trackingType: 'weighted', category: 'legs' },
  { name: 'Squat', icon: 'squat', trackingType: 'weighted', category: 'legs' },
  { name: 'Leg Press', icon: 'leg-press', trackingType: 'weighted', category: 'legs' },
  { name: 'Hip Abductor Machine', icon: 'hip-abductor', trackingType: 'weighted', category: 'legs' },
  { name: 'Leg Extension Machine', icon: 'leg-extension', trackingType: 'weighted', category: 'legs' },
  { name: 'Hamstring Curl Machine', icon: 'hamstring-curl', trackingType: 'weighted', category: 'legs' },
  { name: 'Crunches', icon: 'crunches', trackingType: 'bodyweight', category: 'abs' },
];

const DEFAULT_EXERCISE_BY_NAME = new Map(DEFAULT_EXERCISES.map((exercise) => [exercise.name, exercise]));

function migrateExerciseRecord(exercise) {
  const knownDefault = DEFAULT_EXERCISE_BY_NAME.get(exercise.name);
  return {
    ...exercise,
    trackingType: VALID_TRACKING_TYPES.has(exercise.trackingType)
      ? exercise.trackingType
      : (knownDefault ? knownDefault.trackingType : 'weighted'),
    category: VALID_CATEGORY_IDS.has(exercise.category)
      ? exercise.category
      : (knownDefault ? knownDefault.category : 'uncategorized'),
  };
}

async function seedIfEmpty() {
  const seededMeta = await DB.get('meta', 'seeded');

  if (!seededMeta || !seededMeta.value) {
    // Fresh install — seed the full default library.
    for (const ex of DEFAULT_EXERCISES) {
      await DB.put('exercises', {
        id: uid(),
        name: ex.name,
        icon: ex.icon,
        trackingType: ex.trackingType,
        category: ex.category,
        isPlaceholderIcon: false,
        createdAt: Date.now(),
      });
    }
    await DB.put('meta', { key: 'seeded', value: true });
    await DB.put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
    return;
  }

  // Existing install — add new defaults and migrate exercise metadata in place.
  const schemaMeta = await DB.get('meta', 'schemaVersion');
  const currentSchema = schemaMeta ? schemaMeta.value : 1;
  if (currentSchema < SCHEMA_VERSION) {
    const existing = await DB.getAll('exercises');
    const existingNames = new Set(existing.map((e) => e.name));
    const newOnes = DEFAULT_EXERCISES.filter((ex) => !existingNames.has(ex.name));
    for (const ex of newOnes) {
      await DB.put('exercises', {
        id: uid(),
        name: ex.name,
        icon: ex.icon,
        trackingType: ex.trackingType,
        category: ex.category,
        isPlaceholderIcon: false,
        createdAt: Date.now(),
      });
    }

    const allExercises = await DB.getAll('exercises');
    for (const exercise of allExercises) {
      const migrated = migrateExerciseRecord(exercise);
      if (migrated.trackingType !== exercise.trackingType || migrated.category !== exercise.category) {
        await DB.put('exercises', migrated);
      }
    }
    await DB.put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
  }
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

function assertBackup(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function assertUniqueIds(records, label) {
  const ids = new Set();
  records.forEach((record, index) => {
    assertBackup(isRecord(record), `${label} record ${index + 1} is invalid`);
    assertBackup(isId(record.id), `${label} record ${index + 1} has no valid ID`);
    assertBackup(!ids.has(record.id), `${label} contains duplicate ID ${record.id}`);
    ids.add(record.id);
  });
}

function validateBackupPayload(payload) {
  assertBackup(isRecord(payload), 'Invalid backup file');
  assertBackup(payload.app === 'iron-log', 'This is not an Iron Log backup');
  const version = Number(payload.schemaVersion);
  assertBackup(Number.isInteger(version) && version >= 1, 'Backup schema version is missing or invalid');
  assertBackup(version <= SCHEMA_VERSION, `This backup requires a newer version of Iron Log (schema ${version})`);
  assertBackup(isRecord(payload.data), 'Backup data is missing');

  const data = {};
  DATA_STORES.forEach((storeName) => {
    assertBackup(Array.isArray(payload.data[storeName]), `Backup ${storeName} must be an array`);
    data[storeName] = payload.data[storeName].map((record) => ({ ...record }));
    assertUniqueIds(data[storeName], storeName);
  });

  data.profiles.forEach((profile) => {
    assertBackup(typeof profile.name === 'string' && profile.name.trim(), `Profile ${profile.id} has an invalid name`);
    assertBackup(typeof profile.color === 'string' && profile.color.trim(), `Profile ${profile.id} has an invalid color`);
    assertBackup(isTimestamp(profile.createdAt), `Profile ${profile.id} has an invalid creation date`);
  });

  data.exercises = data.exercises.map(migrateExerciseRecord);
  data.exercises.forEach((exercise) => {
    assertBackup(typeof exercise.name === 'string' && exercise.name.trim(), `Exercise ${exercise.id} has an invalid name`);
    assertBackup(typeof exercise.icon === 'string' && exercise.icon.trim(), `Exercise ${exercise.id} has an invalid icon`);
    assertBackup(VALID_TRACKING_TYPES.has(exercise.trackingType), `Exercise ${exercise.id} has an invalid tracking type`);
    assertBackup(VALID_CATEGORY_IDS.has(exercise.category), `Exercise ${exercise.id} has an invalid category`);
    assertBackup(isTimestamp(exercise.createdAt), `Exercise ${exercise.id} has an invalid creation date`);
    assertBackup(exercise.archived === undefined || typeof exercise.archived === 'boolean', `Exercise ${exercise.id} has an invalid archive status`);
  });

  data.routines.forEach((routine) => {
    assertBackup(typeof routine.name === 'string' && routine.name.trim(), `Routine ${routine.id} has an invalid name`);
    assertBackup(Array.isArray(routine.exerciseIds) && routine.exerciseIds.every(isId), `Routine ${routine.id} has invalid exercises`);
    assertBackup(isTimestamp(routine.createdAt), `Routine ${routine.id} has an invalid creation date`);
    assertBackup(routine.profileId === undefined || routine.profileId === null || isId(routine.profileId), `Routine ${routine.id} has an invalid profile`);
  });

  data.sessions.forEach((session) => {
    assertBackup(isId(session.profileId), `Session ${session.id} has an invalid profile`);
    assertBackup(isISODate(session.date), `Session ${session.id} has an invalid date`);
    assertBackup(session.status === undefined || ['in_progress', 'completed'].includes(session.status), `Session ${session.id} has an invalid status`);
    assertBackup(Array.isArray(session.exerciseIds) && session.exerciseIds.every(isId), `Session ${session.id} has invalid exercises`);
    assertBackup(isTimestamp(session.createdAt), `Session ${session.id} has an invalid creation date`);
    assertBackup(session.completedAt === undefined || isTimestamp(session.completedAt), `Session ${session.id} has an invalid completion date`);
  });

  data.sets.forEach((set) => {
    assertBackup(isId(set.profileId) && isId(set.sessionId) && isId(set.exerciseId), `Set ${set.id} has invalid relationships`);
    assertBackup(isISODate(set.date), `Set ${set.id} has an invalid date`);
    assertBackup(Number.isInteger(set.reps) && set.reps >= 0, `Set ${set.id} has invalid reps`);
    assertBackup(set.weight === null || (Number.isFinite(set.weight) && set.weight >= 0), `Set ${set.id} has an invalid weight`);
    assertBackup(Number.isInteger(set.setNumber) && set.setNumber >= 1, `Set ${set.id} has an invalid set number`);
    assertBackup(isTimestamp(set.createdAt), `Set ${set.id} has an invalid creation date`);
  });

  return {
    app: 'iron-log',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: payload.exportedAt,
    data,
  };
}

function mergeById(existing, incoming) {
  const merged = new Map(existing.map((record) => [record.id, record]));
  incoming.forEach((record) => merged.set(record.id, record));
  return [...merged.values()];
}

function ensureRelationshipIntegrity(data) {
  const profileIds = new Set(data.profiles.map((profile) => profile.id));
  const exerciseIds = new Set(data.exercises.map((exercise) => exercise.id));
  const sessionsById = new Map(data.sessions.map((session) => [session.id, session]));

  data.sessions.forEach((session) => {
    assertBackup(profileIds.has(session.profileId), `Session ${session.id} refers to a missing profile`);
  });

  data.sets.forEach((set) => {
    const session = sessionsById.get(set.sessionId);
    assertBackup(profileIds.has(set.profileId), `Set ${set.id} refers to a missing profile`);
    assertBackup(session, `Set ${set.id} refers to a missing session`);
    assertBackup(session.profileId === set.profileId, `Set ${set.id} does not match its session profile`);
    assertBackup(session.exerciseIds.includes(set.exerciseId), `Set ${set.id} does not match its session exercises`);
  });

  const referencedExerciseIds = new Set();
  data.routines.forEach((routine) => routine.exerciseIds.forEach((id) => referencedExerciseIds.add(id)));
  data.sessions.forEach((session) => session.exerciseIds.forEach((id) => referencedExerciseIds.add(id)));
  data.sets.forEach((set) => referencedExerciseIds.add(set.exerciseId));
  referencedExerciseIds.forEach((id) => {
    if (exerciseIds.has(id)) return;
    data.exercises.push({
      id,
      name: 'Deleted exercise',
      icon: 'barbell-generic',
      trackingType: 'weighted',
      category: 'uncategorized',
      archived: true,
      createdAt: 0,
    });
    exerciseIds.add(id);
  });
}

async function importAllData(payload, { replace = false } = {}) {
  const normalized = validateBackupPayload(payload);
  const incoming = normalized.data;
  const combined = {};

  if (replace) {
    DATA_STORES.forEach((storeName) => { combined[storeName] = [...incoming[storeName]]; });
  } else {
    const existingArrays = await Promise.all(DATA_STORES.map((storeName) => DB.getAll(storeName)));
    DATA_STORES.forEach((storeName, index) => {
      combined[storeName] = mergeById(existingArrays[index], incoming[storeName]);
    });
  }
  ensureRelationshipIntegrity(combined);

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DATA_STORES, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Import failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Import was rolled back'));

    try {
      if (replace) DATA_STORES.forEach((storeName) => transaction.objectStore(storeName).clear());
      DATA_STORES.forEach((storeName) => {
        combined[storeName].forEach((record) => transaction.objectStore(storeName).put(record));
      });
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });

  await DB.put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
  return Object.fromEntries(DATA_STORES.map((storeName) => [storeName, incoming[storeName].length]));
}

window.IronLogDB = {
  DB, uid, seedIfEmpty, exportAllData, importAllData, validateBackupPayload, SCHEMA_VERSION,
  EXERCISE_CATEGORIES, TRACKING_TYPES,
  LBS_PER_KG, lbsToKg, kgToLbs, toDisplayWeight, toStoredLbs,
};
})();
