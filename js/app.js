// app.js — Iron Log main application logic
'use strict';

const {
  DB: Store, uid, seedIfEmpty, exportAllData, importAllData, validateBackupPayload,
  EXERCISE_CATEGORIES, TRACKING_TYPES,
  toDisplayWeight, toStoredLbs,
} = window.IronLogDB;
const {
  localISODate, isoDaysAgo, isBodyweightExercise, setVolume,
  estimatedOneRepMax, sessionDurationMs, rollingAverageByDate, moveArrayItem,
} = window.IronLogDomain;

const ICONS = [
  'bench-press', 'lat-pulldown', 'machine-row', 'machine-shoulder-press',
  'preacher-curl', 'pec-deck', 'triceps-extension',
  'romanian-deadlift', 'squat', 'leg-press', 'hip-abductor',
  'leg-extension', 'hamstring-curl', 'crunches',
  'barbell-generic', 'dumbbell-generic', 'machine-generic',
];

const PROFILE_COLORS = ['#38bdf8', '#fb923c', '#a78bfa', '#4ade80', '#f472b6', '#facc15'];

const RANGES = [
  ['30d', '30D'],
  ['3m', '3M'],
  ['6m', '6M'],
  ['1y', '1Y'],
  ['all', 'All'],
];

const state = {
  profiles: [],
  exercises: [],
  routines: [],
  sessions: [],
  sets: [],
  bodyWeights: [],
  activeProfileId: null,
  // { id, date, routineId, createdAt, exercises: [{exerciseId, sets: [{id, weight(lbs), reps}]}] }
  activeSession: null,
  tab: 'log',
  unit: 'lbs', // 'lbs' | 'kg' — display only; storage is always lbs
  selectedLogDate: null, // date to start the next new workout on
  selectedWeightDate: null,
  progressExerciseId: null,
  progressMetric: 'e1rm', // e1rm | weight | reps | volume
  progressProfileIds: [],
  progressRange: '30d',
  progressView: 'trends',
  historyCalendarYear: null,
  historyCalendarMonth: null, // 0-indexed
  restAlertSeconds: 90,
  restVibrationEnabled: true,
};

const app = document.getElementById('app');
let sessionMonitorId = null;
let wakeLockSentinel = null;

// ---------------- Small helpers ----------------
function iconSrc(icon) {
  return `icons/${icon || 'barbell-generic'}.svg`;
}

function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function todayISO() {
  return localISODate();
}

function exerciseById(id) {
  return state.exercises.find((e) => e.id === id);
}
function profileById(id) {
  return state.profiles.find((p) => p.id === id);
}

function categoryRank(id) {
  const index = EXERCISE_CATEGORIES.findIndex((category) => category.id === id);
  return index === -1 ? EXERCISE_CATEGORIES.length : index;
}

function activeExercises() {
  return state.exercises
    .filter((exercise) => !exercise.archived)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name));
}

function isCompleted(session) {
  return !session.status || session.status === 'completed';
}

function toDisplay(lbsValue) {
  return toDisplayWeight(lbsValue, state.unit);
}

function roundNice(n) {
  return Math.round(n * 10) / 10;
}

function fmtWeight(lbsValue) {
  return roundNice(toDisplay(lbsValue)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + state.unit;
}

function fmtElapsed(ms, compact = false) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (compact && hours === 0) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function fmtDurationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60000) return '<1 min';
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function fmtClockTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function normalizeRestTimer(timer = {}) {
  timer = timer && typeof timer === 'object' ? timer : {};
  const fallbackAlertSeconds = Number.isInteger(state.restAlertSeconds) && state.restAlertSeconds > 0
    ? state.restAlertSeconds
    : 90;
  return {
    alertSeconds: Number.isInteger(timer.alertSeconds) && timer.alertSeconds > 0
      ? timer.alertSeconds
      : fallbackAlertSeconds,
    vibrate: typeof timer.vibrate === 'boolean' ? timer.vibrate : state.restVibrationEnabled,
    elapsedMs: Number.isFinite(timer.elapsedMs) && timer.elapsedMs >= 0 ? timer.elapsedMs : 0,
    startedAt: Number.isFinite(timer.startedAt) ? timer.startedAt : null,
    running: Boolean(timer.running && Number.isFinite(timer.startedAt)),
    alertFired: Boolean(timer.alertFired),
  };
}

async function getMeta(key, fallback) {
  const m = await Store.get('meta', key);
  return m ? m.value : fallback;
}
async function setMeta(key, value) {
  await Store.put('meta', { key, value });
}

// ---------------- Data loading ----------------
async function loadAll() {
  const [profiles, exercises, routines, sessions, sets, bodyWeights] = await Promise.all([
    Store.getAll('profiles'),
    Store.getAll('exercises'),
    Store.getAll('routines'),
    Store.getAll('sessions'),
    Store.getAll('sets'),
    Store.getAll('bodyWeights'),
  ]);
  state.profiles = profiles.sort((a, b) => a.createdAt - b.createdAt);
  state.exercises = exercises.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name));
  state.routines = routines;
  state.sessions = sessions.sort((a, b) => b.date.localeCompare(a.date));
  state.sets = sets;
  state.bodyWeights = bodyWeights.sort((a, b) => b.date.localeCompare(a.date));

  if (state.profiles.length === 0) {
    state.activeProfileId = null;
  } else if (!profileById(state.activeProfileId)) {
    const preferred = state.profiles.find((p) => p.id === state._lastActiveProfileId);
    state.activeProfileId = preferred ? preferred.id : state.profiles[0].id;
  }
}

function reconstructActiveSession(profileId) {
  const inProgress = state.sessions.find((s) => s.profileId === profileId && s.status === 'in_progress');
  if (!inProgress) return null;
  const exerciseIds = [...new Set(inProgress.exerciseIds || [])];
  const exercises = exerciseIds.map((eid) => {
    const sets = state.sets
      .filter((s) => s.sessionId === inProgress.id && s.exerciseId === eid)
      .sort((a, b) => (a.setNumber || 0) - (b.setNumber || 0))
      .map((s) => ({ ...s }));
    return { exerciseId: eid, sets };
  });
  return {
    id: inProgress.id,
    date: inProgress.date,
    routineId: inProgress.routineId,
    createdAt: inProgress.createdAt,
    startedAt: inProgress.startedAt || inProgress.createdAt,
    restTimer: normalizeRestTimer(inProgress.restTimer),
    exercises,
  };
}

async function switchProfile(id) {
  await releaseWorkoutWakeLock();
  state.activeProfileId = id;
  state._lastActiveProfileId = id;
  await setMeta('lastActiveProfileId', id);
  state.activeSession = reconstructActiveSession(id);
  if (state.activeSession?.restTimer?.running) void requestWorkoutWakeLock();
  state.progressProfileIds = [id];
  render();
}

// ---------------- Init ----------------
async function init() {
  await seedIfEmpty();
  state.unit = await getMeta('unitPreference', 'lbs');
  state._lastActiveProfileId = await getMeta('lastActiveProfileId', null);
  state.restAlertSeconds = await getMeta('restAlertSeconds', 90);
  state.restVibrationEnabled = await getMeta('restVibrationEnabled', true);
  state.selectedLogDate = todayISO();
  state.selectedWeightDate = todayISO();

  await loadAll();

  if (state.profiles.length === 0) {
    render(profileOnboardingScreen());
    return;
  }

  state.activeSession = reconstructActiveSession(state.activeProfileId);
  render();
}

// ---------------- Root render / router ----------------
function render(forceScreen) {
  if (sessionMonitorId) {
    clearInterval(sessionMonitorId);
    sessionMonitorId = null;
  }
  if (forceScreen) {
    app.innerHTML = '';
    app.appendChild(forceScreen);
    return;
  }
  if (state.profiles.length === 0) {
    app.innerHTML = '';
    app.appendChild(profileOnboardingScreen());
    return;
  }
  app.innerHTML = '';
  app.appendChild(headerBar());
  const main = document.createElement('main');
  main.className = 'screen';
  main.appendChild(screenFor(state.tab));
  app.appendChild(main);
  app.appendChild(tabBar());
  syncSessionMonitor();
}

function screenFor(tab) {
  switch (tab) {
    case 'log': return logScreen();
    case 'history': return historyScreen();
    case 'progress': return progressScreen();
    case 'exercises': return exercisesScreen();
    case 'profiles': return profilesScreen();
    default: return logScreen();
  }
}

function setTab(tab) {
  state.tab = tab;
  render();
}

// ---------------- Header ----------------
function headerBar() {
  const header = el('header', 'topbar');
  const brand = el('div', 'brand');
  brand.textContent = 'Iron Log';
  header.appendChild(brand);

  const profile = profileById(state.activeProfileId);
  if (profile) {
    const chip = el('button', 'profile-chip');
    chip.style.setProperty('--chip-color', profile.color);
    chip.textContent = profile.name;
    chip.onclick = () => setTab('profiles');
    header.appendChild(chip);
  }
  return header;
}

function tabBar() {
  const bar = el('nav', 'tabbar');
  const tabs = [
    ['log', 'Log'],
    ['history', 'History'],
    ['progress', 'Progress'],
    ['exercises', 'Exercises'],
    ['profiles', 'Profiles'],
  ];
  for (const [id, label] of tabs) {
    const btn = el('button', 'tab' + (state.tab === id ? ' active' : ''));
    btn.textContent = label;
    btn.onclick = () => setTab(id);
    bar.appendChild(btn);
  }
  return bar;
}

// ---------------- DOM helpers ----------------
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconImg(icon, size = 28) {
  const img = document.createElement('img');
  img.src = iconSrc(icon);
  img.className = 'icon-img';
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  img.alt = '';
  return img;
}

function attachReorderInteractions(item, handle, index, itemCount, onMove) {
  item.dataset.reorderIndex = String(index);
  handle.draggable = true;
  handle.setAttribute('aria-label', `${handle.getAttribute('aria-label') || 'Reorder item'}. Use Up or Down arrow keys to move it.`);
  handle.onkeydown = (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const destination = event.key === 'ArrowUp' ? index - 1 : index + 1;
    if (destination >= 0 && destination < itemCount) void onMove(index, destination);
  };
  handle.ondragstart = (event) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    item.classList.add('is-dragging');
  };
  handle.ondragend = () => item.classList.remove('is-dragging');
  item.ondragover = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    item.classList.add('is-drop-target');
  };
  item.ondragleave = () => item.classList.remove('is-drop-target');
  item.ondrop = (event) => {
    event.preventDefault();
    item.classList.remove('is-drop-target');
    const fromIndex = Number(event.dataTransfer.getData('text/plain'));
    if (Number.isInteger(fromIndex) && fromIndex !== index) void onMove(fromIndex, index);
  };

  let pointerDragging = false;
  let pointerTarget = null;
  handle.onpointerdown = (event) => {
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    pointerDragging = true;
    handle.setPointerCapture(event.pointerId);
    item.classList.add('is-dragging');
  };
  handle.onpointermove = (event) => {
    if (!pointerDragging) return;
    const scrollArea = handle.closest('.modal-box, .screen');
    if (scrollArea) {
      const bounds = scrollArea.getBoundingClientRect();
      if (event.clientY < bounds.top + 56) scrollArea.scrollTop -= 18;
      else if (event.clientY > bounds.bottom - 56) scrollArea.scrollTop += 18;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-reorder-index]');
    if (pointerTarget && pointerTarget !== target) pointerTarget.classList.remove('is-drop-target');
    pointerTarget = target;
    if (pointerTarget && pointerTarget !== item) pointerTarget.classList.add('is-drop-target');
  };
  handle.onpointerup = (event) => {
    if (!pointerDragging) return;
    pointerDragging = false;
    item.classList.remove('is-dragging');
    if (pointerTarget) pointerTarget.classList.remove('is-drop-target');
    const destination = Number(pointerTarget?.dataset.reorderIndex);
    pointerTarget = null;
    if (Number.isInteger(destination) && destination !== index) void onMove(index, destination);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.onpointercancel = (event) => {
    pointerDragging = false;
    item.classList.remove('is-dragging');
    if (pointerTarget) pointerTarget.classList.remove('is-drop-target');
    pointerTarget = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
}

function modal(contentEl) {
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal-box');
  box.appendChild(contentEl);
  overlay.appendChild(box);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  return overlay;
}

// ================= PROFILES =================
function profileOnboardingScreen() {
  const wrap = el('div', 'onboarding');
  wrap.appendChild(el('h1', 'onboard-title', 'Iron Log'));
  wrap.appendChild(el('p', 'onboard-sub', 'Create a profile to start logging workouts.'));
  wrap.appendChild(profileForm(async (name, color) => {
    const p = { id: uid(), name, color, createdAt: Date.now() };
    await Store.put('profiles', p);
    await loadAll();
    await switchProfile(p.id);
  }));
  return wrap;
}

function profileForm(onSubmit, existing) {
  const form = el('div', 'form');
  const nameInput = document.createElement('input');
  nameInput.placeholder = 'Profile name';
  nameInput.value = existing ? existing.name : '';
  nameInput.className = 'text-input';
  form.appendChild(nameInput);

  const colorRow = el('div', 'color-row');
  let selectedColor = existing ? existing.color : PROFILE_COLORS[0];
  PROFILE_COLORS.forEach((c) => {
    const dot = el('button', 'color-dot' + (c === selectedColor ? ' selected' : ''));
    dot.style.background = c;
    dot.onclick = () => {
      selectedColor = c;
      [...colorRow.children].forEach((d) => d.classList.remove('selected'));
      dot.classList.add('selected');
    };
    colorRow.appendChild(dot);
  });
  form.appendChild(colorRow);

  const submit = el('button', 'btn primary', existing ? 'Save' : 'Create profile');
  submit.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    onSubmit(name, selectedColor);
  };
  form.appendChild(submit);
  return form;
}

function profilesScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'Profiles'));

  const list = el('div', 'list');
  state.profiles.forEach((p) => {
    const row = el('div', 'list-row' + (p.id === state.activeProfileId ? ' active-row' : ''));
    const dot = el('span', 'swatch');
    dot.style.background = p.color;
    row.appendChild(dot);
    const name = el('span', 'row-label', p.name);
    row.appendChild(name);
    row.style.cursor = 'pointer';
    row.onclick = () => switchProfile(p.id);

    const editBtn = el('button', 'icon-btn', '✎');
    editBtn.onclick = (e) => {
      e.stopPropagation();
      const content = el('div');
      content.appendChild(el('h3', 'modal-title', 'Edit profile'));
      content.appendChild(profileForm(async (name, color) => {
        await Store.put('profiles', { ...p, name, color });
        await loadAll();
        overlay.remove();
        render();
      }, p));
      const delBtn = el('button', 'btn danger', 'Delete profile');
      delBtn.onclick = async () => {
        if (!confirm(`Delete ${p.name} and all their logged data? This cannot be undone.`)) return;
        const sets = await Store.getAllByIndex('sets', 'profileId', p.id);
        for (const s of sets) await Store.delete('sets', s.id);
        const sessions = await Store.getAllByIndex('sessions', 'profileId', p.id);
        for (const s of sessions) await Store.delete('sessions', s.id);
        const bodyWeights = await Store.getAllByIndex('bodyWeights', 'profileId', p.id);
        for (const entry of bodyWeights) await Store.delete('bodyWeights', entry.id);
        await Store.delete('profiles', p.id);
        if (state.activeProfileId === p.id) {
          state.activeProfileId = null;
          state.activeSession = null;
          state.progressProfileIds = [];
          state._lastActiveProfileId = null;
          await setMeta('lastActiveProfileId', null);
        }
        await loadAll();
        state.activeSession = reconstructActiveSession(state.activeProfileId);
        overlay.remove();
        render();
      };
      content.appendChild(delBtn);
      const overlay = modal(content);
    };
    row.appendChild(editBtn);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const addBtn = el('button', 'btn secondary', '+ Add profile');
  addBtn.onclick = () => {
    const content = el('div');
    content.appendChild(el('h3', 'modal-title', 'New profile'));
    content.appendChild(profileForm(async (name, color) => {
      await Store.put('profiles', { id: uid(), name, color, createdAt: Date.now() });
      await loadAll();
      overlay.remove();
      render();
    }));
    const overlay = modal(content);
  };
  wrap.appendChild(addBtn);

  // ---- Units ----
  wrap.appendChild(el('h2', 'section-title', 'Units'));
  const unitRow = el('div', 'btn-row');
  [['lbs', 'lbs'], ['kg', 'kg']].forEach(([val, label]) => {
    const btn = el('button', 'btn small ' + (state.unit === val ? 'primary' : 'secondary'), label);
    btn.onclick = async () => {
      state.unit = val;
      await setMeta('unitPreference', val);
      render();
    };
    unitRow.appendChild(btn);
  });
  wrap.appendChild(unitRow);
  wrap.appendChild(el('p', 'field-hint', 'Your data is always stored consistently — switching units only changes how numbers are displayed.'));

  // ---- Backup ----
  wrap.appendChild(el('h2', 'section-title', 'Backup'));
  const backupRow = el('div', 'btn-row');
  const exportBtn = el('button', 'btn secondary', 'Export data');
  exportBtn.onclick = async () => {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iron-log-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  backupRow.appendChild(exportBtn);

  const importBtn = el('button', 'btn secondary', 'Import data');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json';
  fileInput.style.display = 'none';
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      validateBackupPayload(payload);
      openImportPreview(payload);
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    } finally {
      fileInput.value = '';
    }
  };
  importBtn.onclick = () => fileInput.click();
  backupRow.appendChild(importBtn);
  backupRow.appendChild(fileInput);
  wrap.appendChild(backupRow);

  return wrap;
}

function openImportPreview(payload) {
  const normalized = validateBackupPayload(payload);
  const counts = normalized.data;
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', 'Import backup'));
  content.appendChild(el(
    'p',
    'field-hint',
    `${counts.profiles.length} profiles, ${counts.exercises.length} exercises, ${counts.routines.length} routines, ${counts.sessions.length} workouts, ${counts.sets.length} sets, and ${(counts.bodyWeights || []).length} body-weight entries are ready to import.`
  ));
  content.appendChild(el('p', 'field-hint', 'Merge keeps current records. Replace removes current workout data after the backup has been fully validated.'));

  const actions = el('div', 'btn-row import-actions');
  const mergeBtn = el('button', 'btn secondary', 'Merge');
  const replaceBtn = el('button', 'btn danger', 'Replace all data');
  const cancelBtn = el('button', 'btn secondary', 'Cancel');

  const runImport = async (replace) => {
    if (replace && !confirm('Replace all current Iron Log data with this backup?')) return;
    [mergeBtn, replaceBtn, cancelBtn].forEach((button) => { button.disabled = true; });
    try {
      await importAllData(payload, { replace });
      await loadAll();
      state.activeSession = reconstructActiveSession(state.activeProfileId);
      state.progressProfileIds = state.activeProfileId ? [state.activeProfileId] : [];
      overlay.remove();
      render();
      alert('Backup imported successfully.');
    } catch (error) {
      [mergeBtn, replaceBtn, cancelBtn].forEach((button) => { button.disabled = false; });
      alert('Import was rolled back: ' + error.message);
    }
  };

  mergeBtn.onclick = () => runImport(false);
  replaceBtn.onclick = () => runImport(true);
  cancelBtn.onclick = () => overlay.remove();
  actions.appendChild(mergeBtn);
  actions.appendChild(replaceBtn);
  actions.appendChild(cancelBtn);
  content.appendChild(actions);
  const overlay = modal(content);
}

// ================= EXERCISES =================
function exercisesScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'Exercise library'));

  const controls = el('div', 'exercise-filters');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'text-input';
  searchInput.placeholder = 'Search exercises';
  searchInput.setAttribute('aria-label', 'Search exercises');
  controls.appendChild(searchInput);

  const categoryFilter = document.createElement('select');
  categoryFilter.className = 'select-input';
  categoryFilter.setAttribute('aria-label', 'Filter exercises by category');
  categoryFilter.appendChild(new Option('All categories', 'all'));
  EXERCISE_CATEGORIES.forEach((category) => categoryFilter.appendChild(new Option(category.label, category.id)));
  controls.appendChild(categoryFilter);
  wrap.appendChild(controls);

  const list = el('div', 'list');
  const refreshList = () => {
    list.innerHTML = '';
    const query = searchInput.value.trim().toLocaleLowerCase();
    const selectedCategory = categoryFilter.value;
    const matches = activeExercises().filter((exercise) =>
      (selectedCategory === 'all' || exercise.category === selectedCategory)
      && (!query || exercise.name.toLocaleLowerCase().includes(query))
    );

    EXERCISE_CATEGORIES.forEach((category) => {
      const categoryExercises = matches.filter((exercise) => exercise.category === category.id);
      if (categoryExercises.length === 0) return;
      list.appendChild(el('h3', 'category-heading', category.label));
      categoryExercises.forEach((exercise) => {
        const row = el('div', 'list-row');
        row.appendChild(iconImg(exercise.icon));
        const details = el('span', 'row-details');
        details.appendChild(el('span', 'row-label', exercise.name));
        details.appendChild(el('span', 'row-meta', isBodyweightExercise(exercise) ? 'Bodyweight' : 'Weighted'));
        row.appendChild(details);
        const editBtn = el('button', 'icon-btn', '✎');
        editBtn.setAttribute('aria-label', `Edit ${exercise.name}`);
        editBtn.onclick = () => openExerciseModal(exercise);
        row.appendChild(editBtn);
        list.appendChild(row);
      });
    });

    if (matches.length === 0) list.appendChild(el('p', 'empty-state', 'No exercises match your search.'));
  };
  searchInput.oninput = refreshList;
  categoryFilter.onchange = refreshList;
  refreshList();
  wrap.appendChild(list);

  const addBtn = el('button', 'btn secondary', '+ Add exercise');
  addBtn.onclick = () => openExerciseModal(null);
  wrap.appendChild(addBtn);
  return wrap;
}

function openExerciseModal(existing) {
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', existing ? 'Edit exercise' : 'New exercise'));

  const nameInput = document.createElement('input');
  nameInput.className = 'text-input';
  nameInput.placeholder = 'Exercise name';
  nameInput.value = existing ? existing.name : '';
  content.appendChild(nameInput);

  content.appendChild(el('div', 'field-label', 'Tracking'));
  let selectedTrackingType = existing ? existing.trackingType : 'weighted';
  const typeRow = el('div', 'btn-row tracking-toggle');
  const typeButtons = [];
  TRACKING_TYPES.forEach((type) => {
    const btn = el('button', `btn small ${type.id === selectedTrackingType ? 'primary' : 'secondary'}`, type.label);
    btn.onclick = () => {
      selectedTrackingType = type.id;
      typeButtons.forEach(({ button, id }) => {
        button.className = `btn small ${id === selectedTrackingType ? 'primary' : 'secondary'}`;
      });
    };
    typeButtons.push({ button: btn, id: type.id });
    typeRow.appendChild(btn);
  });
  content.appendChild(typeRow);

  content.appendChild(el('div', 'field-label', 'Category'));
  const categorySelect = document.createElement('select');
  categorySelect.className = 'select-input';
  EXERCISE_CATEGORIES.forEach((category) => {
    const option = new Option(category.label, category.id);
    if (category.id === (existing ? existing.category : 'uncategorized')) option.selected = true;
    categorySelect.appendChild(option);
  });
  content.appendChild(categorySelect);

  content.appendChild(el('div', 'field-label', 'Icon'));
  let selectedIcon = existing ? existing.icon : ICONS[0];
  const iconGrid = el('div', 'icon-grid');
  ICONS.forEach((icon) => {
    const btn = el('button', 'icon-choice' + (icon === selectedIcon ? ' selected' : ''));
    btn.appendChild(iconImg(icon, 32));
    btn.onclick = () => {
      selectedIcon = icon;
      [...iconGrid.children].forEach((c) => c.classList.remove('selected'));
      btn.classList.add('selected');
    };
    iconGrid.appendChild(btn);
  });
  content.appendChild(iconGrid);

  const saveBtn = el('button', 'btn primary', 'Save');
  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    await Store.put('exercises', {
      ...(existing || {}),
      id: existing ? existing.id : uid(),
      name,
      icon: selectedIcon,
      trackingType: selectedTrackingType,
      category: categorySelect.value,
      archived: false,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
    await loadAll();
    overlay.remove();
    render();
  };
  content.appendChild(saveBtn);

  if (existing) {
    const delBtn = el('button', 'btn danger', 'Delete exercise');
    delBtn.onclick = async () => {
      if (!confirm(`Delete ${existing.name}? Past logged sets for it will be kept in history but the exercise won't be selectable anymore.`)) return;
      await Store.put('exercises', { ...existing, archived: true });
      await loadAll();
      overlay.remove();
      render();
    };
    content.appendChild(delBtn);
  }

  const overlay = modal(content);
}

function exercisePicker({ selected = new Set(), excludedIds = new Set(), onSingleSelect = null, onSelectionChange = null } = {}) {
  const wrap = el('div', 'exercise-picker');
  const controls = el('div', 'exercise-filters');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'text-input';
  searchInput.placeholder = 'Search exercises';
  searchInput.setAttribute('aria-label', 'Search exercises');
  controls.appendChild(searchInput);

  const categoryFilter = document.createElement('select');
  categoryFilter.className = 'select-input';
  categoryFilter.setAttribute('aria-label', 'Filter exercises by category');
  categoryFilter.appendChild(new Option('All categories', 'all'));
  EXERCISE_CATEGORIES.forEach((category) => categoryFilter.appendChild(new Option(category.label, category.id)));
  controls.appendChild(categoryFilter);
  wrap.appendChild(controls);

  const list = el('div', 'exercise-select-list');
  wrap.appendChild(list);

  const refresh = () => {
    list.innerHTML = '';
    const query = searchInput.value.trim().toLocaleLowerCase();
    const selectedCategory = categoryFilter.value;
    const matches = activeExercises().filter((exercise) =>
      !excludedIds.has(exercise.id)
      && (selectedCategory === 'all' || exercise.category === selectedCategory)
      && (!query || exercise.name.toLocaleLowerCase().includes(query))
    );

    EXERCISE_CATEGORIES.forEach((category) => {
      const categoryExercises = matches.filter((exercise) => exercise.category === category.id);
      if (categoryExercises.length === 0) return;
      list.appendChild(el('div', 'picker-category', category.label));
      categoryExercises.forEach((exercise) => {
        const row = el('button', 'select-row' + (selected.has(exercise.id) ? ' selected' : ''));
        row.appendChild(iconImg(exercise.icon, 24));
        const details = el('span', 'row-details');
        details.appendChild(el('span', 'row-label', exercise.name));
        details.appendChild(el('span', 'row-meta', isBodyweightExercise(exercise) ? 'Bodyweight' : 'Weighted'));
        row.appendChild(details);
        row.onclick = () => {
          if (onSingleSelect) {
            onSingleSelect(exercise);
            return;
          }
          if (selected.has(exercise.id)) {
            selected.delete(exercise.id);
            row.classList.remove('selected');
          } else {
            selected.add(exercise.id);
            row.classList.add('selected');
          }
          if (onSelectionChange) onSelectionChange(exercise, selected.has(exercise.id));
        };
        list.appendChild(row);
      });
    });
    if (matches.length === 0) list.appendChild(el('p', 'empty-state', 'No exercises match your search.'));
  };
  searchInput.oninput = refresh;
  categoryFilter.onchange = refresh;
  refresh();
  return wrap;
}

// ================= LOG =================
function bodyWeightForDate(date, profileId = state.activeProfileId) {
  return state.bodyWeights.find((entry) => entry.profileId === profileId && entry.date === date) || null;
}

function bodyWeightEntryCard({ compact = false } = {}) {
  const card = el('section', compact ? 'weight-entry compact' : 'weight-entry');
  const heading = el('div', 'weight-entry-head');
  const copy = el('div');
  copy.appendChild(el('h3', '', 'Body weight'));
  copy.appendChild(el('p', 'field-hint', 'One entry per day. Saving again updates it.'));
  heading.appendChild(copy);
  card.appendChild(heading);

  const form = el('div', 'weight-entry-form');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'text-input';
  dateInput.value = state.selectedWeightDate || todayISO();
  dateInput.setAttribute('aria-label', 'Body-weight date');
  const weightWrap = el('label', 'weight-input-wrap');
  const weightInput = document.createElement('input');
  weightInput.type = 'number';
  weightInput.inputMode = 'decimal';
  weightInput.min = '1';
  weightInput.step = '0.1';
  weightInput.className = 'text-input';
  weightInput.placeholder = `Weight (${state.unit})`;
  weightInput.setAttribute('aria-label', `Body weight in ${state.unit}`);
  weightWrap.appendChild(weightInput);
  weightWrap.appendChild(el('span', 'weight-unit', state.unit));
  const saveBtn = el('button', 'btn primary', 'Save weight');
  const deleteBtn = el('button', 'btn danger small weight-delete', 'Delete');
  deleteBtn.hidden = true;

  const loadDate = () => {
    const existing = bodyWeightForDate(dateInput.value);
    weightInput.value = existing ? String(roundNice(toDisplay(existing.weight))) : '';
    saveBtn.textContent = existing ? 'Update weight' : 'Save weight';
    deleteBtn.hidden = !existing;
  };
  dateInput.onchange = () => {
    state.selectedWeightDate = dateInput.value || todayISO();
    loadDate();
  };
  loadDate();

  saveBtn.onclick = async () => {
    const displayWeight = Number(weightInput.value);
    if (!Number.isFinite(displayWeight) || displayWeight <= 0) {
      weightInput.focus();
      return;
    }
    const existing = bodyWeightForDate(dateInput.value);
    const now = Date.now();
    await Store.put('bodyWeights', {
      id: existing ? existing.id : uid(),
      profileId: state.activeProfileId,
      date: dateInput.value || todayISO(),
      weight: toStoredLbs(displayWeight, state.unit),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
    await loadAll();
    render();
  };
  deleteBtn.onclick = async () => {
    const existing = bodyWeightForDate(dateInput.value);
    if (!existing || !confirm(`Delete the body-weight entry for ${fmtDate(existing.date)}?`)) return;
    await Store.delete('bodyWeights', existing.id);
    await loadAll();
    render();
  };

  form.appendChild(dateInput);
  form.appendChild(weightWrap);
  form.appendChild(saveBtn);
  form.appendChild(deleteBtn);
  card.appendChild(form);
  return card;
}

function logScreen() {
  const wrap = el('div', 'section');

  if (!state.activeSession) {
    wrap.appendChild(el('h2', 'section-title', 'Start a workout'));

    wrap.appendChild(bodyWeightEntryCard());

    wrap.appendChild(el('div', 'field-label', 'Date'));
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'text-input';
    dateInput.value = state.selectedLogDate || todayISO();
    dateInput.onchange = () => { state.selectedLogDate = dateInput.value || todayISO(); };
    wrap.appendChild(dateInput);

    const startFreeform = el('button', 'btn primary', 'Start freeform workout');
    startFreeform.onclick = () => openSessionSetup(null, []);
    wrap.appendChild(startFreeform);

    wrap.appendChild(el('h2', 'section-title', 'Routines'));
    const list = el('div', 'list');
    state.routines.forEach((r) => {
      const row = el('div', 'list-row');
      row.appendChild(el('span', 'row-label', r.name));
      row.style.cursor = 'pointer';
      row.onclick = () => openSessionSetup(r.id, r.exerciseIds);
      const editBtn = el('button', 'icon-btn', '✎');
      editBtn.setAttribute('aria-label', `Edit ${r.name}`);
      editBtn.onclick = (e) => {
        e.stopPropagation();
        openRoutineModal(r);
      };
      row.appendChild(editBtn);
      const delBtn = el('button', 'icon-btn', '✕');
      delBtn.setAttribute('aria-label', `Delete ${r.name}`);
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete routine "${r.name}"?`)) return;
        await Store.delete('routines', r.id);
        await loadAll();
        render();
      };
      row.appendChild(delBtn);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    const newRoutineBtn = el('button', 'btn secondary', '+ Create routine');
    newRoutineBtn.onclick = () => openRoutineModal();
    wrap.appendChild(newRoutineBtn);

    return wrap;
  }

  return activeSessionView();
}

function openRoutineModal(existing = null) {
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', existing ? 'Edit routine' : 'New routine'));
  const nameInput = document.createElement('input');
  nameInput.className = 'text-input';
  nameInput.placeholder = 'Routine name (e.g. Push Day)';
  nameInput.value = existing ? existing.name : '';
  content.appendChild(nameInput);

  const selectableRoutineIds = new Set(activeExercises().map((exercise) => exercise.id));
  let selectedOrder = existing
    ? [...new Set(existing.exerciseIds || [])].filter((id) => selectableRoutineIds.has(id))
    : [];
  const selected = new Set(selectedOrder);
  const orderHeading = el('div', 'field-label', 'Exercise order');
  const orderList = el('div', 'routine-order-list');
  const renderOrder = () => {
    orderList.innerHTML = '';
    selectedOrder = selectedOrder.filter((id) => selected.has(id) && exerciseById(id));
    if (selectedOrder.length === 0) {
      orderList.appendChild(el('p', 'field-hint', 'Select exercises below, then drag them into order.'));
      return;
    }
    selectedOrder.forEach((id, index) => {
      const exercise = exerciseById(id);
      const row = el('div', 'routine-order-row');
      row.appendChild(iconImg(exercise.icon, 24));
      row.appendChild(el('span', 'row-label', exercise.name));
      const handle = el('button', 'drag-handle', '⠿');
      handle.type = 'button';
      handle.setAttribute('aria-label', `Reorder ${exercise.name}`);
      row.appendChild(handle);
      attachReorderInteractions(row, handle, index, selectedOrder.length, async (from, to) => {
        selectedOrder = moveArrayItem(selectedOrder, from, to);
        renderOrder();
        requestAnimationFrame(() => orderList.querySelectorAll('.drag-handle')[to]?.focus());
      });
      orderList.appendChild(row);
    });
  };
  content.appendChild(orderHeading);
  content.appendChild(orderList);
  content.appendChild(exercisePicker({
    selected,
    onSelectionChange: (exercise, isSelected) => {
      if (isSelected && !selectedOrder.includes(exercise.id)) selectedOrder.push(exercise.id);
      if (!isSelected) selectedOrder = selectedOrder.filter((id) => id !== exercise.id);
      renderOrder();
    },
  }));
  renderOrder();

  const saveBtn = el('button', 'btn primary', existing ? 'Save changes' : 'Save routine');
  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name || selected.size === 0) { alert('Name the routine and pick at least one exercise.'); return; }
    const exerciseIds = selectedOrder.filter((id) => selected.has(id));
    await Store.put('routines', {
      ...(existing || {}),
      id: existing ? existing.id : uid(),
      name,
      exerciseIds,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
    await loadAll();
    overlay.remove();
    render();
  };
  content.appendChild(saveBtn);
  if (existing) {
    const deleteBtn = el('button', 'btn danger', 'Delete routine');
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete routine "${existing.name}"?`)) return;
      await Store.delete('routines', existing.id);
      await loadAll();
      overlay.remove();
      render();
    };
    content.appendChild(deleteBtn);
  }
  const overlay = modal(content);
}

// ---- Active session: persistence-backed lifecycle ----
function openSessionSetup(routineId, exerciseIds) {
  const routine = state.routines.find((item) => item.id === routineId);
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', routine ? `Start ${routine.name}` : 'Start freeform workout'));
  content.appendChild(el('p', 'field-hint', 'Set an optional vibration alert for the rest stopwatch. The stopwatch itself is always available.'));

  const timeRow = el('div', 'timer-setup-row');
  const minutesField = el('label', 'timer-number-field');
  minutesField.appendChild(el('span', 'field-label', 'Minutes'));
  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.inputMode = 'numeric';
  minutesInput.min = '0';
  minutesInput.max = '99';
  minutesInput.className = 'text-input';
  minutesInput.value = String(Math.floor(state.restAlertSeconds / 60));
  minutesField.appendChild(minutesInput);
  const secondsField = el('label', 'timer-number-field');
  secondsField.appendChild(el('span', 'field-label', 'Seconds'));
  const secondsInput = document.createElement('input');
  secondsInput.type = 'number';
  secondsInput.inputMode = 'numeric';
  secondsInput.min = '0';
  secondsInput.max = '59';
  secondsInput.className = 'text-input';
  secondsInput.value = String(state.restAlertSeconds % 60);
  secondsField.appendChild(secondsInput);
  timeRow.appendChild(minutesField);
  timeRow.appendChild(secondsField);
  content.appendChild(timeRow);

  const vibrationLabel = el('label', 'check-row');
  const vibrationInput = document.createElement('input');
  vibrationInput.type = 'checkbox';
  vibrationInput.checked = state.restVibrationEnabled;
  vibrationInput.disabled = !('vibrate' in navigator);
  vibrationLabel.appendChild(vibrationInput);
  vibrationLabel.appendChild(document.createTextNode(
    'vibrate' in navigator ? 'Vibrate when the rest time is reached' : 'Vibration is not supported on this device'
  ));
  content.appendChild(vibrationLabel);

  const startBtn = el('button', 'btn primary', 'Start workout');
  startBtn.onclick = async () => {
    const minutes = Math.max(0, Math.min(99, Math.floor(Number(minutesInput.value) || 0)));
    const seconds = Math.max(0, Math.min(59, Math.floor(Number(secondsInput.value) || 0)));
    const alertSeconds = Math.max(1, (minutes * 60) + seconds);
    state.restAlertSeconds = alertSeconds;
    state.restVibrationEnabled = vibrationInput.checked;
    await Promise.all([
      setMeta('restAlertSeconds', alertSeconds),
      setMeta('restVibrationEnabled', vibrationInput.checked),
    ]);
    overlay.remove();
    await startSession(routineId, exerciseIds, {
      alertSeconds,
      vibrate: vibrationInput.checked,
    });
  };
  content.appendChild(startBtn);
  const overlay = modal(content);
}

async function startSession(routineId, exerciseIds, restOptions = {}) {
  if (!profileById(state.activeProfileId)) {
    state.activeProfileId = null;
    state.activeSession = null;
    render();
    alert('Create or select a profile before starting a workout.');
    return;
  }
  const selectableIds = new Set(activeExercises().map((exercise) => exercise.id));
  const uniqueExerciseIds = [...new Set(exerciseIds || [])].filter((id) => selectableIds.has(id));
  const now = Date.now();
  const session = {
    id: uid(),
    profileId: state.activeProfileId,
    date: state.selectedLogDate || todayISO(),
    routineId: routineId || null,
    status: 'in_progress',
    exerciseIds: uniqueExerciseIds,
    createdAt: now,
    startedAt: now,
    restTimer: normalizeRestTimer(restOptions),
  };
  await Store.put('sessions', session);
  state.activeSession = {
    id: session.id,
    date: session.date,
    routineId: session.routineId,
    createdAt: now,
    startedAt: now,
    restTimer: normalizeRestTimer(session.restTimer),
    exercises: uniqueExerciseIds.map((eid) => ({ exerciseId: eid, sets: [] })),
  };
  render();
}

async function persistSessionShell() {
  const s = state.activeSession;
  await Store.put('sessions', {
    id: s.id,
    profileId: state.activeProfileId,
    date: s.date,
    routineId: s.routineId,
    status: 'in_progress',
    exerciseIds: s.exercises.map((e) => e.exerciseId),
    createdAt: s.createdAt,
    startedAt: s.startedAt || s.createdAt,
    restTimer: normalizeRestTimer(s.restTimer),
  });
}

async function addExerciseToActiveSession(exerciseId) {
  if (state.activeSession.exercises.some((entry) => entry.exerciseId === exerciseId)) return;
  state.activeSession.exercises.push({ exerciseId, sets: [] });
  await persistSessionShell();
  render();
}

async function removeExerciseFromActiveSession(idx) {
  const exEntry = state.activeSession.exercises[idx];
  for (const s of exEntry.sets) {
    if (s.id) await Store.delete('sets', s.id);
  }
  state.activeSession.exercises.splice(idx, 1);
  await persistSessionShell();
  render();
}

async function reorderActiveExercise(fromIndex, toIndex) {
  state.activeSession.exercises = moveArrayItem(state.activeSession.exercises, fromIndex, toIndex);
  await persistSessionShell();
  render();
  requestAnimationFrame(() => document.querySelectorAll('.exercise-card .drag-handle')[toIndex]?.focus());
}

async function addSetToExercise(exEntry) {
  const last = exEntry.sets[exEntry.sets.length - 1];
  const exercise = exerciseById(exEntry.exerciseId);
  const bodyweight = isBodyweightExercise(exercise);
  const newSet = {
    id: uid(),
    profileId: state.activeProfileId,
    sessionId: state.activeSession.id,
    exerciseId: exEntry.exerciseId,
    date: state.activeSession.date,
    setNumber: exEntry.sets.length + 1,
    weight: bodyweight ? null : (last && Number.isFinite(last.weight) ? last.weight : 0),
    reps: last ? last.reps : 0,
    createdAt: Date.now(),
  };
  exEntry.sets.push(newSet);
  await Store.put('sets', newSet);
  render();
}

async function persistSet(setObj) {
  await Store.put('sets', { ...setObj });
}

async function deleteSetAt(exEntry, idx) {
  const s = exEntry.sets[idx];
  if (s.id) await Store.delete('sets', s.id);
  exEntry.sets.splice(idx, 1);
  await Promise.all(exEntry.sets.map((set, index) => {
    set.setNumber = index + 1;
    return persistSet(set);
  }));
  render();
}

function restElapsedMs(timer, now = Date.now()) {
  if (!timer) return 0;
  return timer.elapsedMs + (timer.running && timer.startedAt ? Math.max(0, now - timer.startedAt) : 0);
}

async function requestWorkoutWakeLock() {
  if (!('wakeLock' in navigator) || wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch (_) {
    wakeLockSentinel = null;
  }
}

async function releaseWorkoutWakeLock() {
  const sentinel = wakeLockSentinel;
  wakeLockSentinel = null;
  if (!sentinel) return;
  try { await sentinel.release(); } catch (_) { /* The operating system may have released it already. */ }
}

function restTimerPanel(session) {
  session.restTimer = normalizeRestTimer(session.restTimer);
  const timer = session.restTimer;
  const panel = el('section', 'rest-timer');
  panel.setAttribute('aria-label', 'Rest stopwatch');

  const header = el('div', 'rest-timer-head');
  const timerCopy = el('div');
  timerCopy.appendChild(el('span', 'rest-timer-label', `Rest stopwatch · alert at ${fmtElapsed(timer.alertSeconds * 1000, true)}`));
  const value = el('div', 'rest-timer-value', fmtElapsed(restElapsedMs(timer)));
  value.id = 'restTimerValue';
  value.setAttribute('aria-live', 'off');
  timerCopy.appendChild(value);
  header.appendChild(timerCopy);
  const status = el('span', 'rest-timer-status', timer.alertFired ? 'Rest target reached' : (timer.running ? 'Running' : 'Ready'));
  status.id = 'restTimerStatus';
  header.appendChild(status);
  panel.appendChild(header);

  const actions = el('div', 'rest-timer-actions');
  const startBtn = el('button', 'btn primary small', 'Start');
  startBtn.disabled = timer.running;
  startBtn.onclick = async () => {
    timer.startedAt = Date.now();
    timer.running = true;
    void requestWorkoutWakeLock();
    await persistSessionShell();
    render();
  };
  const stopBtn = el('button', 'btn secondary small', 'Stop');
  stopBtn.disabled = !timer.running;
  stopBtn.onclick = async () => {
    timer.elapsedMs = restElapsedMs(timer);
    timer.startedAt = null;
    timer.running = false;
    await persistSessionShell();
    await releaseWorkoutWakeLock();
    render();
  };
  const resetBtn = el('button', 'btn secondary small', 'Reset');
  resetBtn.onclick = async () => {
    timer.elapsedMs = 0;
    timer.startedAt = null;
    timer.running = false;
    timer.alertFired = false;
    await persistSessionShell();
    await releaseWorkoutWakeLock();
    render();
  };
  actions.appendChild(startBtn);
  actions.appendChild(stopBtn);
  actions.appendChild(resetBtn);
  panel.appendChild(actions);

  const settings = document.createElement('details');
  settings.className = 'rest-timer-settings';
  const summary = document.createElement('summary');
  summary.textContent = 'Alert settings';
  settings.appendChild(summary);
  const fields = el('div', 'timer-setup-row');
  const minutesField = el('label', 'timer-number-field');
  minutesField.appendChild(el('span', 'field-label', 'Minutes'));
  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.inputMode = 'numeric';
  minutesInput.min = '0';
  minutesInput.max = '99';
  minutesInput.className = 'text-input';
  minutesInput.value = String(Math.floor(timer.alertSeconds / 60));
  minutesField.appendChild(minutesInput);
  const secondsField = el('label', 'timer-number-field');
  secondsField.appendChild(el('span', 'field-label', 'Seconds'));
  const secondsInput = document.createElement('input');
  secondsInput.type = 'number';
  secondsInput.inputMode = 'numeric';
  secondsInput.min = '0';
  secondsInput.max = '59';
  secondsInput.className = 'text-input';
  secondsInput.value = String(timer.alertSeconds % 60);
  secondsField.appendChild(secondsInput);
  fields.appendChild(minutesField);
  fields.appendChild(secondsField);
  settings.appendChild(fields);

  const vibrationLabel = el('label', 'check-row compact');
  const vibrationInput = document.createElement('input');
  vibrationInput.type = 'checkbox';
  vibrationInput.checked = timer.vibrate;
  vibrationInput.disabled = !('vibrate' in navigator);
  vibrationLabel.appendChild(vibrationInput);
  vibrationLabel.appendChild(document.createTextNode(
    'vibrate' in navigator ? 'Vibrate at the alert time' : 'Vibration unavailable on this device'
  ));
  settings.appendChild(vibrationLabel);

  const saveSettings = async () => {
    const minutes = Math.max(0, Math.min(99, Math.floor(Number(minutesInput.value) || 0)));
    const seconds = Math.max(0, Math.min(59, Math.floor(Number(secondsInput.value) || 0)));
    timer.alertSeconds = Math.max(1, (minutes * 60) + seconds);
    timer.vibrate = vibrationInput.checked;
    timer.alertFired = restElapsedMs(timer) >= timer.alertSeconds * 1000;
    state.restAlertSeconds = timer.alertSeconds;
    state.restVibrationEnabled = timer.vibrate;
    await Promise.all([
      persistSessionShell(),
      setMeta('restAlertSeconds', timer.alertSeconds),
      setMeta('restVibrationEnabled', timer.vibrate),
    ]);
    render();
  };
  minutesInput.onchange = saveSettings;
  secondsInput.onchange = saveSettings;
  vibrationInput.onchange = saveSettings;
  panel.appendChild(settings);
  return panel;
}

function updateSessionIndicators() {
  const session = state.activeSession;
  if (!session) return;
  const now = Date.now();
  const workoutDuration = document.getElementById('workoutDurationValue');
  if (workoutDuration) workoutDuration.textContent = `Workout ${fmtElapsed(now - (session.startedAt || session.createdAt))}`;

  // Keep the same timer object that the Start/Stop/Reset buttons close over.
  // Replacing it on every 250 ms update makes those buttons mutate a stale copy.
  if (!session.restTimer) session.restTimer = normalizeRestTimer();
  const timer = session.restTimer;
  const timerValue = document.getElementById('restTimerValue');
  if (timerValue) timerValue.textContent = fmtElapsed(restElapsedMs(timer, now));

  const thresholdReached = restElapsedMs(timer, now) >= timer.alertSeconds * 1000;
  if (thresholdReached && !timer.alertFired) {
    timer.alertFired = true;
    void persistSessionShell();
    if (timer.vibrate && 'vibrate' in navigator) navigator.vibrate([250, 120, 250]);
  }
  const timerPanel = document.querySelector('.rest-timer');
  if (timerPanel) timerPanel.classList.toggle('target-reached', timer.alertFired);
  const timerStatus = document.getElementById('restTimerStatus');
  if (timerStatus) timerStatus.textContent = timer.alertFired ? 'Rest target reached' : (timer.running ? 'Running' : 'Ready');
}

function syncSessionMonitor() {
  updateSessionIndicators();
  if (!state.activeSession) return;
  sessionMonitorId = setInterval(updateSessionIndicators, 250);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeSession && state.activeSession.restTimer?.running) {
    void requestWorkoutWakeLock();
    updateSessionIndicators();
  }
});

function activeSessionView() {
  const session = state.activeSession;
  const wrap = el('div', 'section');

  const topRow = el('div', 'session-top');
  const isToday = session.date === todayISO();
  const sessionHeading = el('div', 'session-heading');
  sessionHeading.appendChild(el('h2', 'section-title', isToday ? 'Today\u2019s workout' : `Workout \u2014 ${fmtDate(session.date)}`));
  const duration = el('span', 'session-duration', `Workout ${fmtElapsed(Date.now() - (session.startedAt || session.createdAt))}`);
  duration.id = 'workoutDurationValue';
  sessionHeading.appendChild(duration);
  topRow.appendChild(sessionHeading);
  const finishBtn = el('button', 'btn primary small', 'Finish');
  finishBtn.onclick = () => openFinishSessionModal();
  topRow.appendChild(finishBtn);
  wrap.appendChild(topRow);
  wrap.appendChild(restTimerPanel(session));

  session.exercises.forEach((exEntry, exIdx) => {
    const ex = exerciseById(exEntry.exerciseId);
    if (!ex) return;
    const bodyweight = isBodyweightExercise(ex);
    const card = el('div', 'exercise-card');
    const head = el('div', 'exercise-card-head');
    head.appendChild(iconImg(ex.icon));
    const exerciseDetails = el('span', 'row-details');
    exerciseDetails.appendChild(el('span', 'row-label', ex.name));
    exerciseDetails.appendChild(el('span', 'row-meta', bodyweight ? 'Bodyweight' : 'Weighted'));
    head.appendChild(exerciseDetails);
    const reorderBtn = el('button', 'drag-handle', '⠿');
    reorderBtn.type = 'button';
    reorderBtn.setAttribute('aria-label', `Reorder ${ex.name}`);
    head.appendChild(reorderBtn);
    const removeExBtn = el('button', 'icon-btn', '✕');
    removeExBtn.setAttribute('aria-label', `Remove ${ex.name} from workout`);
    removeExBtn.onclick = () => removeExerciseFromActiveSession(exIdx);
    head.appendChild(removeExBtn);
    card.appendChild(head);
    attachReorderInteractions(card, reorderBtn, exIdx, session.exercises.length, reorderActiveExercise);

    const setsList = el('div', 'sets-list');
    const setHeaderRow = el('div', 'set-row set-header' + (bodyweight ? ' bodyweight' : ''));
    setHeaderRow.appendChild(el('span', 'set-col', 'Set'));
    if (!bodyweight) setHeaderRow.appendChild(el('span', 'set-col', `Weight (${state.unit})`));
    setHeaderRow.appendChild(el('span', 'set-col', 'Reps'));
    setHeaderRow.appendChild(el('span', 'set-col', ''));
    setsList.appendChild(setHeaderRow);

    exEntry.sets.forEach((s, setIdx) => {
      const row = el('div', 'set-row' + (bodyweight ? ' bodyweight' : ''));
      row.appendChild(el('span', 'set-col', String(setIdx + 1)));

      if (!bodyweight) {
        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.inputMode = 'decimal';
        weightInput.min = '0';
        weightInput.step = 'any';
        weightInput.className = 'set-input';
        weightInput.setAttribute('aria-label', `${ex.name} set ${setIdx + 1} weight in ${state.unit}`);
        weightInput.value = roundNice(toDisplay(s.weight));
        weightInput.onchange = async () => {
          const entered = Number(weightInput.value);
          const validValue = Number.isFinite(entered) && entered >= 0 ? entered : 0;
          weightInput.value = String(validValue);
          s.weight = toStoredLbs(validValue, state.unit);
          await persistSet(s);
        };
        const wCol = el('span', 'set-col'); wCol.appendChild(weightInput);
        row.appendChild(wCol);
      }

      const repsInput = document.createElement('input');
      repsInput.type = 'number';
      repsInput.inputMode = 'numeric';
      repsInput.min = '0';
      repsInput.step = '1';
      repsInput.className = 'set-input';
      repsInput.setAttribute('aria-label', `${ex.name} set ${setIdx + 1} reps`);
      repsInput.value = s.reps;
      repsInput.onchange = async () => {
        const entered = Number(repsInput.value);
        s.reps = Number.isFinite(entered) && entered >= 0 ? Math.floor(entered) : 0;
        repsInput.value = String(s.reps);
        await persistSet(s);
      };
      const rCol = el('span', 'set-col'); rCol.appendChild(repsInput);
      row.appendChild(rCol);

      const delSetBtn = el('button', 'icon-btn small', '✕');
      delSetBtn.setAttribute('aria-label', `Delete ${ex.name} set ${setIdx + 1}`);
      delSetBtn.onclick = () => deleteSetAt(exEntry, setIdx);
      const dCol = el('span', 'set-col'); dCol.appendChild(delSetBtn);
      row.appendChild(dCol);

      setsList.appendChild(row);
    });
    card.appendChild(setsList);

    const addSetBtn = el('button', 'btn secondary small', '+ Add set');
    addSetBtn.onclick = () => addSetToExercise(exEntry);
    card.appendChild(addSetBtn);

    wrap.appendChild(card);
  });

  const addExerciseBtn = el('button', 'btn secondary', '+ Add exercise to workout');
  addExerciseBtn.onclick = () => {
    const content = el('div');
    content.appendChild(el('h3', 'modal-title', 'Add exercise'));
    const excludedIds = new Set(session.exercises.map((entry) => entry.exerciseId));
    content.appendChild(exercisePicker({
      excludedIds,
      onSingleSelect: async (exercise) => {
        overlay.remove();
        await addExerciseToActiveSession(exercise.id);
      },
    }));
    const overlay = modal(content);
  };
  wrap.appendChild(addExerciseBtn);

  const cancelBtn = el('button', 'btn danger', 'Cancel workout');
  cancelBtn.onclick = () => cancelActiveSession(false);
  wrap.appendChild(cancelBtn);

  return wrap;
}

function openFinishSessionModal() {
  const session = state.activeSession;
  if (!session) return;
  const hasSets = session.exercises.some((exercise) => exercise.sets.length > 0);
  if (!hasSets) {
    void finishSession();
    return;
  }

  const elapsedMs = Date.now() - (session.startedAt || session.createdAt);
  const totalMinutes = Math.max(1, Math.round(elapsedMs / 60000));
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', 'Finish workout'));
  content.appendChild(el('p', 'field-hint', `Started ${fmtClockTime(session.startedAt || session.createdAt)} · finishing now`));
  content.appendChild(el('div', 'field-label', 'Workout duration'));

  const durationRow = el('div', 'timer-setup-row');
  const hoursField = el('label', 'timer-number-field');
  hoursField.appendChild(el('span', 'field-label', 'Hours'));
  const hoursInput = document.createElement('input');
  hoursInput.type = 'number';
  hoursInput.inputMode = 'numeric';
  hoursInput.min = '0';
  hoursInput.max = '99';
  hoursInput.className = 'text-input';
  hoursInput.value = String(Math.floor(totalMinutes / 60));
  hoursField.appendChild(hoursInput);
  const minutesField = el('label', 'timer-number-field');
  minutesField.appendChild(el('span', 'field-label', 'Minutes'));
  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.inputMode = 'numeric';
  minutesInput.min = '0';
  minutesInput.max = '59';
  minutesInput.className = 'text-input';
  minutesInput.value = String(totalMinutes % 60);
  minutesField.appendChild(minutesInput);
  durationRow.appendChild(hoursField);
  durationRow.appendChild(minutesField);
  content.appendChild(durationRow);

  let durationEdited = false;
  hoursInput.oninput = () => { durationEdited = true; };
  minutesInput.oninput = () => { durationEdited = true; };

  const confirmBtn = el('button', 'btn primary', 'Save workout');
  confirmBtn.onclick = async () => {
    const hours = Math.max(0, Math.min(99, Math.floor(Number(hoursInput.value) || 0)));
    const minutes = Math.max(0, Math.min(59, Math.floor(Number(minutesInput.value) || 0)));
    const durationSeconds = durationEdited ? Math.max(60, ((hours * 60) + minutes) * 60) : null;
    confirmBtn.disabled = true;
    await finishSession(durationSeconds);
    overlay.remove();
  };
  content.appendChild(confirmBtn);
  const overlay = modal(content);
}

async function cancelActiveSession(skipConfirm) {
  if (!skipConfirm && !confirm('Discard this workout?')) return;
  const session = state.activeSession;
  for (const exEntry of session.exercises) {
    for (const s of exEntry.sets) {
      if (s.id) await Store.delete('sets', s.id);
    }
  }
  await Store.delete('sessions', session.id);
  await releaseWorkoutWakeLock();
  state.activeSession = null;
  await loadAll();
  render();
}

async function finishSession(durationSecondsOverride = null) {
  const session = state.activeSession;
  const hasSets = session.exercises.some((e) => e.sets.length > 0);
  if (!hasSets) {
    if (!confirm('No sets logged. Discard this workout?')) return;
    await cancelActiveSession(true);
    return;
  }

  const completedAt = Date.now();
  const startedAt = session.startedAt || session.createdAt || completedAt;
  const timer = normalizeRestTimer(session.restTimer);
  timer.elapsedMs = restElapsedMs(timer, completedAt);
  timer.startedAt = null;
  timer.running = false;
  await Store.put('sessions', {
    id: session.id,
    profileId: state.activeProfileId,
    date: session.date,
    routineId: session.routineId,
    status: 'completed',
    exerciseIds: session.exercises.map((e) => e.exerciseId),
    createdAt: session.createdAt || Date.now(),
    startedAt,
    completedAt,
    durationSeconds: Number.isInteger(durationSecondsOverride)
      ? durationSecondsOverride
      : Math.max(0, Math.round((completedAt - startedAt) / 1000)),
    restTimer: timer,
  });

  await releaseWorkoutWakeLock();
  state.activeSession = null;
  state.selectedLogDate = todayISO();
  await loadAll();
  setTab('history');
}

// ================= HISTORY =================
function historyScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'History'));

  const mySessions = state.sessions.filter((s) => s.profileId === state.activeProfileId && isCompleted(s));

  if (mySessions.length === 0) {
    wrap.appendChild(el('p', 'empty-state', 'No workouts logged yet. Start one from the Log tab.'));
    return wrap;
  }

  wrap.appendChild(historyCalendar(mySessions));

  const list = el('div', 'list');
  mySessions.forEach((session) => {
    const sessionSets = state.sets.filter((s) => s.sessionId === session.id);
    const loggedExerciseIds = new Set(sessionSets.map((set) => set.exerciseId));
    const exerciseIds = (session.exerciseIds || []).filter((id) => loggedExerciseIds.has(id));
    const weightedVolumeLbs = sessionSets.reduce((sum, set) => {
      const exercise = exerciseById(set.exerciseId);
      return isBodyweightExercise(exercise) ? sum : sum + setVolume(set, exercise);
    }, 0);
    const bodyweightReps = sessionSets.reduce((sum, set) => {
      const exercise = exerciseById(set.exerciseId);
      return isBodyweightExercise(exercise) ? sum + set.reps : sum;
    }, 0);

    const row = el('div', 'history-row');
    row.style.cursor = 'pointer';
    row.onclick = () => openWorkoutDetailModal(session);

    const dateRow = el('div', 'history-date-row');
    dateRow.appendChild(el('span', 'history-date', fmtDate(session.date)));
    const summaryParts = [];
    const durationMs = sessionDurationMs(session);
    if (durationMs !== null) summaryParts.push(fmtDurationLabel(durationMs));
    if (weightedVolumeLbs > 0) summaryParts.push(`${roundNice(toDisplay(weightedVolumeLbs)).toLocaleString()} ${state.unit} vol`);
    if (bodyweightReps > 0) summaryParts.push(`${bodyweightReps.toLocaleString()} reps`);
    dateRow.appendChild(el('span', 'history-volume', summaryParts.join(' · ') || 'No volume'));
    row.appendChild(dateRow);

    const chips = el('div', 'exercise-chips');
    exerciseIds.forEach((eid) => {
      const ex = exerciseById(eid);
      if (!ex) return;
      const chip = el('span', 'exercise-chip');
      chip.appendChild(iconImg(ex.icon, 18));
      chip.appendChild(document.createTextNode(ex.name));
      chips.appendChild(chip);
    });
    row.appendChild(chips);

    const delBtn = el('button', 'icon-btn', '✕');
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this workout entry?')) return;
      for (const s of sessionSets) await Store.delete('sets', s.id);
      await Store.delete('sessions', session.id);
      await loadAll();
      render();
    };
    row.appendChild(delBtn);

    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function historyCalendar(mySessions) {
  const now = new Date();
  if (state.historyCalendarYear === null) {
    state.historyCalendarYear = now.getFullYear();
    state.historyCalendarMonth = now.getMonth();
  }
  const year = state.historyCalendarYear;
  const month = state.historyCalendarMonth;

  const workoutDates = new Set(mySessions.map((s) => s.date));

  const wrap = el('div', 'calendar-wrap');

  const nav = el('div', 'calendar-nav');
  const prevBtn = el('button', 'icon-btn', '‹');
  prevBtn.onclick = () => {
    state.historyCalendarMonth -= 1;
    if (state.historyCalendarMonth < 0) { state.historyCalendarMonth = 11; state.historyCalendarYear -= 1; }
    render();
  };
  const label = el('span', 'calendar-label', new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  const nextBtn = el('button', 'icon-btn', '›');
  nextBtn.onclick = () => {
    state.historyCalendarMonth += 1;
    if (state.historyCalendarMonth > 11) { state.historyCalendarMonth = 0; state.historyCalendarYear += 1; }
    render();
  };
  nav.appendChild(prevBtn);
  nav.appendChild(label);
  nav.appendChild(nextBtn);
  wrap.appendChild(nav);

  const grid = el('div', 'calendar-grid');
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => grid.appendChild(el('div', 'calendar-weekday', d)));

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) grid.appendChild(el('div', 'calendar-day empty'));

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const hasWorkout = workoutDates.has(iso);
    const cell = el('div', 'calendar-day' + (hasWorkout ? ' has-workout' : '') + (iso === todayISO() ? ' is-today' : ''));
    cell.textContent = String(day);
    if (hasWorkout) {
      cell.onclick = () => {
        const sessionsForDay = mySessions.filter((s) => s.date === iso);
        sessionsForDay.forEach((s) => openWorkoutDetailModal(s));
      };
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function openWorkoutDetailModal(session) {
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', fmtDate(session.date)));

  const sessionSets = state.sets.filter((s) => s.sessionId === session.id);
  const loggedExerciseIds = new Set(sessionSets.map((set) => set.exerciseId));
  const exerciseIds = (session.exerciseIds || []).filter((id) => loggedExerciseIds.has(id));
  const weightedVolumeLbs = sessionSets.reduce((sum, set) => {
    const exercise = exerciseById(set.exerciseId);
    return isBodyweightExercise(exercise) ? sum : sum + setVolume(set, exercise);
  }, 0);
  const bodyweightReps = sessionSets.reduce((sum, set) => {
    const exercise = exerciseById(set.exerciseId);
    return isBodyweightExercise(exercise) ? sum + set.reps : sum;
  }, 0);

  const workoutSummary = [];
  const durationMs = sessionDurationMs(session);
  if (durationMs !== null) workoutSummary.push(`Duration: ${fmtDurationLabel(durationMs)}`);
  if (weightedVolumeLbs > 0) workoutSummary.push(`Weighted volume: ${roundNice(toDisplay(weightedVolumeLbs)).toLocaleString()} ${state.unit}`);
  if (bodyweightReps > 0) workoutSummary.push(`Bodyweight volume: ${bodyweightReps.toLocaleString()} reps`);
  content.appendChild(el('p', 'field-hint', workoutSummary.join(' · ') || 'No volume recorded'));
  if (Number.isFinite(session.startedAt || session.createdAt) && Number.isFinite(session.completedAt)) {
    content.appendChild(el('p', 'history-time-range', `${fmtClockTime(session.startedAt || session.createdAt)}–${fmtClockTime(session.completedAt)}`));
  }

  exerciseIds.forEach((eid) => {
    const ex = exerciseById(eid);
    const bodyweight = isBodyweightExercise(ex);
    const exSets = sessionSets.filter((s) => s.exerciseId === eid).sort((a, b) => (a.setNumber || 0) - (b.setNumber || 0));
    const exerciseVolume = exSets.reduce((sum, set) => sum + setVolume(set, ex), 0);

    const card = el('div', 'exercise-card');
    const head = el('div', 'exercise-card-head');
    head.appendChild(iconImg(ex ? ex.icon : 'barbell-generic'));
    head.appendChild(el('span', 'row-label', ex ? ex.name : 'Deleted exercise'));
    card.appendChild(head);

    const setsList = el('div', 'sets-list');
    const setHeaderRow = el('div', `set-row set-header read-only ${bodyweight ? 'history-bodyweight' : 'history-weighted'}`);
    setHeaderRow.appendChild(el('span', 'set-col', 'Set'));
    if (!bodyweight) setHeaderRow.appendChild(el('span', 'set-col', `Weight (${state.unit})`));
    setHeaderRow.appendChild(el('span', 'set-col', 'Reps'));
    setsList.appendChild(setHeaderRow);

    exSets.forEach((s, idx) => {
      const row = el('div', `set-row read-only ${bodyweight ? 'history-bodyweight' : 'history-weighted'}`);
      row.appendChild(el('span', 'set-col', String(idx + 1)));
      if (!bodyweight) row.appendChild(el('span', 'set-col', String(roundNice(toDisplay(s.weight)))));
      row.appendChild(el('span', 'set-col', String(s.reps)));
      setsList.appendChild(row);
    });
    card.appendChild(setsList);
    card.appendChild(el(
      'p',
      'field-hint',
      bodyweight
        ? `Exercise volume: ${exerciseVolume.toLocaleString()} reps`
        : `Exercise volume: ${roundNice(toDisplay(exerciseVolume)).toLocaleString()} ${state.unit}`
    ));

    content.appendChild(card);
  });

  modal(content);
}

// ================= PROGRESS =================
function rangeStartDate(range) {
  if (range === '7d') return isoDaysAgo(7);
  if (range === '30d') return isoDaysAgo(30);
  if (range === '3m') return isoDaysAgo(90);
  if (range === '6m') return isoDaysAgo(180);
  if (range === '1y') return isoDaysAgo(365);
  if (range === 'ytd') return `${todayISO().slice(0, 4)}-01-01`;
  return null; // all
}

function completedSetsFor(profileId, exerciseId = null) {
  const completedSessionIds = new Set(
    state.sessions
      .filter((session) => session.profileId === profileId && isCompleted(session))
      .map((session) => session.id)
  );
  return state.sets.filter((set) =>
    set.profileId === profileId
    && completedSessionIds.has(set.sessionId)
    && (exerciseId === null || set.exerciseId === exerciseId)
  );
}

function exerciseProgressPoints(profileId, exercise, metric) {
  const rangeStart = rangeStartDate(state.progressRange);
  let sets = completedSetsFor(profileId, exercise.id);
  if (rangeStart) sets = sets.filter((set) => set.date >= rangeStart);
  const byDate = {};
  sets.forEach((set) => {
    let value = 0;
    if (metric === 'e1rm') {
      const estimate = estimatedOneRepMax(set.weight, set.reps);
      if (estimate === null) return;
      value = estimate;
      byDate[set.date] = Math.max(byDate[set.date] || 0, value);
    } else if (metric === 'reps') {
      value = Number(set.reps) || 0;
      byDate[set.date] = Math.max(byDate[set.date] || 0, value);
    } else if (metric === 'weight') {
      value = Number(set.weight) || 0;
      byDate[set.date] = Math.max(byDate[set.date] || 0, value);
    } else {
      value = setVolume(set, exercise);
      byDate[set.date] = (byDate[set.date] || 0) + value;
    }
  });
  return Object.keys(byDate).sort().map((date) => {
    const shouldConvertWeight = !isBodyweightExercise(exercise) && metric !== 'reps';
    return { x: date, y: roundNice(shouldConvertWeight ? toDisplay(byDate[date]) : byDate[date]) };
  });
}

function bodyWeightProgressPoints(profileId) {
  const rangeStart = rangeStartDate(state.progressRange);
  const allEntries = state.bodyWeights
    .filter((entry) => entry.profileId === profileId)
    .map((entry) => ({ date: entry.date, weight: entry.weight }));
  const rolling = rollingAverageByDate(allEntries, 7);
  return {
    daily: rolling
      .filter((entry) => !rangeStart || entry.date >= rangeStart)
      .map((entry) => ({ x: entry.date, y: roundNice(toDisplay(entry.weight)) })),
    average: rolling
      .filter((entry) => !rangeStart || entry.date >= rangeStart)
      .map((entry) => ({ x: entry.date, y: roundNice(toDisplay(entry.average)) })),
  };
}

function currentTrendPoints() {
  if (state.progressExerciseId === 'body-weight') {
    return bodyWeightProgressPoints(state.activeProfileId).average;
  }
  const exercise = exerciseById(state.progressExerciseId);
  return exercise ? exerciseProgressPoints(state.activeProfileId, exercise, state.progressMetric) : [];
}

function trendChangeLabel(points, isBodyWeight) {
  if (!points || points.length < 2) return null;
  const first = points[0].y;
  const last = points[points.length - 1].y;
  const delta = last - first;
  if (isBodyWeight) {
    return {
      positive: null,
      text: `${delta >= 0 ? '\u25B2' : '\u25BC'} ${Math.abs(delta).toFixed(1)} ${state.unit}`,
    };
  }
  if (!first) return null;
  const pct = (delta / Math.abs(first)) * 100;
  return {
    positive: pct >= 0,
    text: `${pct >= 0 ? '\u25B2' : '\u25BC'} ${Math.abs(pct).toFixed(1)}%`,
  };
}

function progressScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'Progress'));

  const tabs = el('div', 'progress-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Progress views');
  [['trends', 'Trends'], ['records', 'Records']].forEach(([value, label]) => {
    const button = el('button', 'progress-tab' + (state.progressView === value ? ' active' : ''), label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.progressView === value));
    button.onclick = () => { state.progressView = value; render(); };
    tabs.appendChild(button);
  });
  wrap.appendChild(tabs);

  if (state.progressView === 'records') {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    wrap.appendChild(progressRecordsPanel());
  } else {
    wrap.appendChild(progressTrendsPanel());
  }
  return wrap;
}

function progressTrendsPanel() {
  const panel = el('section', 'progress-panel');
  const selectableExercises = activeExercises();
  const hasSelectedExercise = selectableExercises.some((exercise) => exercise.id === state.progressExerciseId);
  if (state.progressExerciseId !== 'body-weight' && !hasSelectedExercise) {
    state.progressExerciseId = selectableExercises[0]?.id || 'body-weight';
  }
  state.progressProfileIds = state.progressProfileIds.filter((id) => profileById(id));
  if (state.progressProfileIds.length === 0) state.progressProfileIds = [state.activeProfileId];

  const isBodyWeight = state.progressExerciseId === 'body-weight';
  const selectedExercise = isBodyWeight ? null : exerciseById(state.progressExerciseId);
  const bodyweightExercise = selectedExercise ? isBodyweightExercise(selectedExercise) : false;
  const validMetrics = isBodyWeight ? [] : (bodyweightExercise ? ['reps', 'volume'] : ['e1rm', 'weight', 'volume']);
  if (!isBodyWeight && !validMetrics.includes(state.progressMetric)) {
    state.progressMetric = bodyweightExercise ? 'reps' : 'e1rm';
  }

  const subjectSelect = document.createElement('select');
  subjectSelect.className = 'select-input progress-subject';
  subjectSelect.setAttribute('aria-label', 'Progress subject');
  subjectSelect.appendChild(new Option('Body weight', 'body-weight'));
  EXERCISE_CATEGORIES.forEach((category) => {
    const groupExercises = selectableExercises.filter((exercise) => exercise.category === category.id);
    if (groupExercises.length === 0) return;
    const group = document.createElement('optgroup');
    group.label = category.label;
    groupExercises.forEach((exercise) => group.appendChild(new Option(exercise.name, exercise.id)));
    subjectSelect.appendChild(group);
  });
  subjectSelect.value = state.progressExerciseId;
  subjectSelect.onchange = () => {
    state.progressExerciseId = subjectSelect.value;
    if (subjectSelect.value === 'body-weight') state.progressMetric = 'weight';
    else state.progressMetric = isBodyweightExercise(exerciseById(subjectSelect.value)) ? 'reps' : 'e1rm';
    render();
  };
  panel.appendChild(subjectSelect);

  if (isBodyWeight) {
    panel.appendChild(bodyWeightEntryCard({ compact: true }));
  } else {
    const metricRow = el('div', 'btn-row wrap progress-metrics');
    validMetrics.forEach((metric) => {
      const labels = { e1rm: 'Estimated 1RM', weight: 'Top weight', reps: 'Best set reps', volume: 'Volume' };
      const button = el('button', 'btn small ' + (state.progressMetric === metric ? 'primary' : 'secondary'), labels[metric]);
      button.onclick = () => { state.progressMetric = metric; render(); };
      metricRow.appendChild(button);
    });
    panel.appendChild(metricRow);
    if (state.progressMetric === 'e1rm') panel.appendChild(el('p', 'field-hint', 'Epley estimate based on weighted sets of 1–10 reps.'));
  }

  const rangeRow = el('div', 'btn-row wrap progress-ranges');
  RANGES.forEach(([value, label]) => {
    const button = el('button', 'btn small ' + (state.progressRange === value ? 'primary' : 'secondary'), label);
    button.onclick = () => { state.progressRange = value; render(); };
    rangeRow.appendChild(button);
  });
  panel.appendChild(rangeRow);

  if (!isBodyWeight && state.profiles.length > 1) {
    panel.appendChild(el('div', 'field-label', 'Compare profiles'));
    const userRow = el('div', 'btn-row wrap');
    state.profiles.forEach((profile) => {
      const active = state.progressProfileIds.includes(profile.id);
      const button = el('button', 'chip-toggle' + (active ? ' active' : ''));
      button.style.setProperty('--chip-color', profile.color);
      button.textContent = profile.name;
      button.onclick = () => {
        if (active && state.progressProfileIds.length > 1) {
          state.progressProfileIds = state.progressProfileIds.filter((id) => id !== profile.id);
        } else if (!active) {
          state.progressProfileIds = [...state.progressProfileIds, profile.id];
        }
        render();
      };
      userRow.appendChild(button);
    });
    panel.appendChild(userRow);
  }

  const points = currentTrendPoints();
  const change = trendChangeLabel(points, isBodyWeight);
  if (change) {
    const tickerClass = change.positive === null ? 'neutral' : (change.positive ? 'positive' : 'negative');
    const ticker = el('div', 'pct-ticker ' + tickerClass, change.text);
    panel.appendChild(ticker);
  }

  if (points.length === 0) {
    panel.appendChild(el('p', 'empty-state', isBodyWeight ? 'Log your first body weight to start this trend.' : 'Complete a workout with this exercise to start its trend.'));
    return panel;
  }

  const canvasWrap = el('div', 'chart-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'progressChart';
  canvasWrap.appendChild(canvas);
  panel.appendChild(canvasWrap);
  requestAnimationFrame(() => drawProgressChart(canvas));
  return panel;
}

function progressRecordsPanel() {
  const panel = el('section', 'progress-panel');
  const sessions = state.sessions.filter((session) => session.profileId === state.activeProfileId && isCompleted(session));
  const completedSets = completedSetsFor(state.activeProfileId);
  const trainingDays = new Set(sessions.map((session) => session.date)).size;
  const weightedVolume = completedSets.reduce((sum, set) => {
    const exercise = exerciseById(set.exerciseId);
    return !exercise || isBodyweightExercise(exercise) ? sum : sum + setVolume(set, exercise);
  }, 0);

  const stats = el('div', 'stats-row records-stats');
  stats.appendChild(statCard('Workouts', sessions.length));
  stats.appendChild(statCard('Training days', trainingDays));
  stats.appendChild(statCard(`Volume (${state.unit})`, roundNice(toDisplay(weightedVolume)).toLocaleString()));
  panel.appendChild(stats);

  if (sessions.length > 0) {
    const milestones = [1, 10, 25, 50, 100, 250, 500];
    const unlocked = [...milestones].reverse().find((value) => sessions.length >= value) || 1;
    const next = milestones.find((value) => value > sessions.length);
    const trophy = el('div', 'achievement-card');
    trophy.appendChild(el('span', 'achievement-icon', '\uD83C\uDFC6'));
    const copy = el('div');
    copy.appendChild(el('div', 'row-label', unlocked === 1 ? 'First workout' : `${unlocked}-workout milestone`));
    copy.appendChild(el('div', 'row-meta', next ? `${next - sessions.length} workouts until ${next}` : 'Top workout milestone reached'));
    trophy.appendChild(copy);
    panel.appendChild(trophy);
  }

  panel.appendChild(el('h3', 'records-heading', 'Exercise records'));
  const records = el('div', 'records-list');
  activeExercises().forEach((exercise) => {
    const sets = completedSets.filter((set) => set.exerciseId === exercise.id);
    if (sets.length === 0) return;
    const bodyweight = isBodyweightExercise(exercise);
    const row = el('article', 'record-row');
    const head = el('div', 'record-exercise');
    head.appendChild(iconImg(exercise.icon, 28));
    head.appendChild(el('span', 'row-label', exercise.name));
    row.appendChild(head);

    if (bodyweight) {
      const best = sets.reduce((winner, set) => !winner || set.reps > winner.reps ? set : winner, null);
      head.appendChild(el('span', 'record-date', fmtDate(best.date)));
      const values = el('div', 'record-values');
      values.appendChild(recordValue('Best set', `${best.reps} reps`));
      const bySession = {};
      sets.forEach((set) => { bySession[set.sessionId] = (bySession[set.sessionId] || 0) + setVolume(set, exercise); });
      values.appendChild(recordValue('Best session', `${Math.max(...Object.values(bySession))} reps`));
      values.appendChild(recordValue('Total reps', sets.reduce((sum, set) => sum + set.reps, 0).toLocaleString()));
      row.appendChild(values);
    } else {
      const topWeight = sets.reduce((winner, set) => !winner || set.weight > winner.weight ? set : winner, null);
      const estimates = sets
        .map((set) => ({ set, value: estimatedOneRepMax(set.weight, set.reps) }))
        .filter((record) => record.value !== null);
      const bestEstimate = estimates.reduce((winner, record) => !winner || record.value > winner.value ? record : winner, null);
      const recordSet = (bestEstimate || { set: topWeight }).set;
      head.appendChild(el('span', 'record-date', fmtDate(recordSet.date)));
      const bySession = {};
      sets.forEach((set) => { bySession[set.sessionId] = (bySession[set.sessionId] || 0) + setVolume(set, exercise); });
      const bestSessionVolume = Math.max(...Object.values(bySession));
      const values = el('div', 'record-values');
      values.appendChild(recordValue('Top weight', fmtWeight(topWeight.weight)));
      values.appendChild(recordValue('Est. 1RM', bestEstimate ? fmtWeight(bestEstimate.value) : '—'));
      values.appendChild(recordValue('Best session', `${roundNice(toDisplay(bestSessionVolume)).toLocaleString()} ${state.unit}`));
      row.appendChild(values);
    }
    records.appendChild(row);
  });
  if (records.children.length === 0) records.appendChild(el('p', 'empty-state', 'Complete a workout to begin collecting records.'));
  panel.appendChild(records);
  panel.appendChild(el('p', 'field-hint', 'Estimated 1RM uses the Epley formula and is shown only for weighted sets of 1–10 reps.'));
  return panel;
}

function recordValue(label, value) {
  const wrap = el('div', 'record-value');
  wrap.appendChild(el('span', 'row-meta', label));
  wrap.appendChild(el('strong', '', value));
  return wrap;
}

function statCard(label, value) {
  const card = el('div', 'stat-card');
  card.appendChild(el('div', 'stat-value', String(value)));
  card.appendChild(el('div', 'stat-label', label));
  return card;
}

let chartInstance = null;
function drawProgressChart(canvas) {
  if (!canvas || !window.Chart) return;
  const isBodyWeight = state.progressExerciseId === 'body-weight';
  const exercise = isBodyWeight ? null : exerciseById(state.progressExerciseId);
  const bodyweightExercise = exercise ? isBodyweightExercise(exercise) : false;
  let datasets;
  let yAxisTitle;
  if (isBodyWeight) {
    const points = bodyWeightProgressPoints(state.activeProfileId);
    datasets = [
      {
        label: 'Daily weight',
        data: points.daily,
        borderColor: '#64748b',
        backgroundColor: '#64748b',
        pointRadius: 3,
        borderWidth: 1,
        tension: 0.2,
      },
      {
        label: '7-day average',
        data: points.average,
        borderColor: '#38bdf8',
        backgroundColor: '#38bdf8',
        pointRadius: 2,
        borderWidth: 3,
        tension: 0.25,
      },
    ];
    yAxisTitle = `Body weight (${state.unit})`;
  } else {
    datasets = state.progressProfileIds.map((profileId) => {
      const profile = profileById(profileId);
      return {
        label: profile ? profile.name : 'Unknown',
        data: exerciseProgressPoints(profileId, exercise, state.progressMetric),
        borderColor: profile ? profile.color : '#38bdf8',
        backgroundColor: profile ? profile.color : '#38bdf8',
        pointRadius: 3,
        borderWidth: 2,
        tension: 0.25,
      };
    });
    const metricLabels = {
      e1rm: `Estimated 1RM (${state.unit})`,
      weight: `Top weight (${state.unit})`,
      reps: 'Best set reps',
      volume: bodyweightExercise ? 'Session reps' : `Volume (${state.unit})`,
    };
    yAxisTitle = metricLabels[state.progressMetric];
  }

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: '#e2e8f0', usePointStyle: true } },
      },
      scales: {
        x: { type: 'time', time: { unit: 'day' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        y: {
          beginAtZero: !isBodyWeight && (bodyweightExercise || state.progressMetric === 'volume'),
          ticks: { color: '#94a3b8' },
          grid: { color: '#334155' },
          title: {
            display: true,
            text: yAxisTitle,
            color: '#94a3b8',
          },
        },
      },
    },
  });
}

// ---------------- Start ----------------
init();
