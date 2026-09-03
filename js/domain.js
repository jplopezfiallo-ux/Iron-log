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

return {
  EXERCISE_CATEGORIES,
  TRACKING_TYPES,
  localISODate,
  isoDaysAgo,
  trackingTypeFor,
  isBodyweightExercise,
  setVolume,
  aggregateByDate,
};
});
