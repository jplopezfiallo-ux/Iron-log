'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const domain = require('../js/domain.js');

function test(name, callback) {
  try {
    callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('localISODate uses the local calendar date late at night', () => {
  assert.equal(domain.localISODate(new Date(2026, 8, 2, 23, 45)), '2026-09-02');
});

test('isoDaysAgo crosses year boundaries in local time', () => {
  assert.equal(domain.isoDaysAgo(1, new Date(2026, 0, 1, 1, 0)), '2025-12-31');
});

test('weighted volume sums weight times reps', () => {
  const exercise = { trackingType: 'weighted' };
  const sets = [
    { date: '2026-09-01', weight: 100, reps: 5 },
    { date: '2026-09-01', weight: 120, reps: 3 },
  ];
  assert.deepEqual(domain.aggregateByDate(sets, 'volume', exercise), { '2026-09-01': 860 });
  assert.deepEqual(domain.aggregateByDate(sets, 'weight', exercise), { '2026-09-01': 120 });
});

test('bodyweight volume sums reps and never uses weight', () => {
  const exercise = { trackingType: 'bodyweight' };
  const sets = [
    { date: '2026-09-01', weight: 999, reps: 12 },
    { date: '2026-09-01', weight: 999, reps: 8 },
  ];
  assert.deepEqual(domain.aggregateByDate(sets, 'volume', exercise), { '2026-09-01': 20 });
  assert.equal(domain.setVolume(sets[0], exercise), 12);
});

const dbContext = {
  window: { IronLogDomain: domain },
  indexedDB: { open() { throw new Error('IndexedDB should not be opened by validation tests'); } },
};
vm.createContext(dbContext);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8'),
  dbContext,
  { filename: 'db.js' }
);
const { validateBackupPayload } = dbContext.window.IronLogDB;

function backup(overrides = {}) {
  return {
    app: 'iron-log',
    schemaVersion: 2,
    exportedAt: '2026-09-02T00:00:00.000Z',
    data: {
      profiles: [{ id: 'p1', name: 'Test', color: '#38bdf8', createdAt: 1 }],
      exercises: [{ id: 'e1', name: 'Crunches', icon: 'crunches', createdAt: 1 }],
      routines: [],
      sessions: [{ id: 's1', profileId: 'p1', date: '2026-09-02', status: 'completed', exerciseIds: ['e1'], createdAt: 1, completedAt: 2 }],
      sets: [{ id: 'set1', profileId: 'p1', sessionId: 's1', exerciseId: 'e1', date: '2026-09-02', setNumber: 1, weight: 0, reps: 10, createdAt: 1 }],
      ...overrides,
    },
  };
}

test('V2 exercises receive V3 tracking metadata during import validation', () => {
  const normalized = validateBackupPayload(backup());
  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.data.exercises[0].trackingType, 'bodyweight');
  assert.equal(normalized.data.exercises[0].category, 'abs');
});

test('custom legacy exercises default to weighted and uncategorized', () => {
  const normalized = validateBackupPayload(backup({
    exercises: [{ id: 'e1', name: 'Custom movement', icon: 'barbell-generic', createdAt: 1 }],
  }));
  assert.equal(normalized.data.exercises[0].trackingType, 'weighted');
  assert.equal(normalized.data.exercises[0].category, 'uncategorized');
});

test('backup validation rejects the wrong application', () => {
  const payload = backup();
  payload.app = 'another-app';
  assert.throws(() => validateBackupPayload(payload), /not an Iron Log backup/);
});

test('backup validation rejects duplicate record IDs', () => {
  const payload = backup();
  payload.data.profiles.push({ ...payload.data.profiles[0] });
  assert.throws(() => validateBackupPayload(payload), /duplicate ID/);
});

console.log('All Iron Log tests passed.');
