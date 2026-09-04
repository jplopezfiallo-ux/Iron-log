// domain.js — Pure exercise, date, and progress helpers for Iron Log
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IronLogDomain = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
'use strict';

const EXERCISE_CATEGORIES = [
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'chest', label: 'Chest' },
  { id: 'arms', label: 'Arms' },
  { id: 'back', label: 'Back' },
  { id: 'legs', label: 'Legs' },
  { id: 'abs', label: 'Abs' },
  { id: 'uncategorized', label: 'Uncategorized' },
];

const TRACKING_TYPES = [
  { id: 'weighted', label: 'Weighted' },
  { id: 'bodyweight', label: 'Bodyweight' },
];

function localISODate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoDaysAgo(days, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return localISODate(date);
}

function trackingTypeFor(exercise) {
  return exercise && exercise.trackingType === 'bodyweight' ? 'bodyweight' : 'weighted';
}

function isBodyweightExercise(exercise) {
  return trackingTypeFor(exercise) === 'bodyweight';
}

function setVolume(set, exercise) {
  const reps = Number.isFinite(Number(set.reps)) ? Number(set.reps) : 0;
  if (isBodyweightExercise(exercise)) return reps;
  const weight = Number.isFinite(Number(set.weight)) ? Number(set.weight) : 0;
  return weight * reps;
}

function aggregateByDate(sets, metric, exercise) {
  const byDate = {};
  const bodyweight = isBodyweightExercise(exercise);
  sets.forEach((set) => {
    if (!set || typeof set.date !== 'string') return;
    const value = metric === 'weight' && !bodyweight
      ? Number(set.weight) || 0
      : setVolume(set, exercise);
    if (!(set.date in byDate)) byDate[set.date] = metric === 'weight' && !bodyweight ? -Infinity : 0;
    byDate[set.date] = metric === 'weight' && !bodyweight
      ? Math.max(byDate[set.date], value)
      : byDate[set.date] + value;
  });
  return byDate;
}

function estimatedOneRepMax(weight, reps) {
  const parsedWeight = Number(weight);
  const parsedReps = Number(reps);
  if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) return null;
  if (!Number.isInteger(parsedReps) || parsedReps < 1 || parsedReps > 10) return null;
  if (parsedReps === 1) return parsedWeight;
  return parsedWeight * (1 + parsedReps / 30);
}

function sessionDurationMs(session) {
  if (!session) return null;
  if (Number.isFinite(session.durationSeconds) && session.durationSeconds >= 0) {
    return session.durationSeconds * 1000;
  }
  const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : session.createdAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(session.completedAt) || session.completedAt < startedAt) return null;
  return session.completedAt - startedAt;
}

function rollingAverageByDate(entries, windowDays = 7) {
  const valid = entries
    .filter((entry) => entry && typeof entry.date === 'string' && Number.isFinite(Number(entry.weight)))
    .map((entry) => ({ date: entry.date, weight: Number(entry.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const days = Math.max(1, Math.floor(Number(windowDays) || 1));
  return valid.map((entry, index) => {
    const end = Date.parse(`${entry.date}T00:00:00Z`);
    const start = end - ((days - 1) * 86400000);
    const windowEntries = valid.slice(0, index + 1).filter((candidate) => {
      const timestamp = Date.parse(`${candidate.date}T00:00:00Z`);
      return timestamp >= start && timestamp <= end;
    });
    return {
      date: entry.date,
      weight: entry.weight,
      average: windowEntries.reduce((sum, candidate) => sum + candidate.weight, 0) / windowEntries.length,
    };
  });
}

function moveArrayItem(items, fromIndex, toIndex) {
  const next = [...items];
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return next;
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length || fromIndex === toIndex) return next;
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

return {
  EXERCISE_CATEGORIES,
  TRACKING_TYPES,
  localISODate,
  isoDaysAgo,
  trackingTypeFor,
  isBodyweightExercise,
  setVolume,
  aggregateByDate,
  estimatedOneRepMax,
  sessionDurationMs,
  rollingAverageByDate,
  moveArrayItem,
};
});
