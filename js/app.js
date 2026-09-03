// app.js — Iron Log main application logic
'use strict';

const {
  DB: Store, uid, seedIfEmpty, exportAllData, importAllData,
  toDisplayWeight, toStoredLbs,
} = window.IronLogDB;

const ICONS = [
  'bench-press', 'lat-pulldown', 'machine-row', 'machine-shoulder-press',
  'preacher-curl', 'pec-deck', 'triceps-extension',
  'romanian-deadlift', 'squat', 'leg-press', 'hip-abductor',
  'leg-extension', 'hamstring-curl', 'crunches',
  'barbell-generic', 'dumbbell-generic', 'machine-generic',
];

const PROFILE_COLORS = ['#38bdf8', '#fb923c', '#a78bfa', '#4ade80', '#f472b6', '#facc15'];

const RANGES = [
  ['7d', '7D'],
  ['30d', '30D'],
  ['1y', '1Y'],
  ['ytd', 'YTD'],
  ['all', 'All'],
];

const state = {
  profiles: [],
  exercises: [],
  routines: [],
  sessions: [],
  sets: [],
  activeProfileId: null,
  // { id, date, routineId, createdAt, exercises: [{exerciseId, sets: [{id, weight(lbs), reps}]}] }
  activeSession: null,
  tab: 'log',
  unit: 'lbs', // 'lbs' | 'kg' — display only; storage is always lbs
  selectedLogDate: null, // date to start the next new workout on
  progressExerciseId: null,
  progressMetric: 'weight', // weight | volume
  progressProfileIds: [],
  progressRange: '30d',
  historyCalendarYear: null,
  historyCalendarMonth: null, // 0-indexed
};

const app = document.getElementById('app');

// ---------------- Small helpers ----------------
function iconSrc(icon) {
  return `icons/${icon || 'barbell-generic'}.svg`;
}

function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function exerciseById(id) {
  return state.exercises.find((e) => e.id === id);
}
function profileById(id) {
  return state.profiles.find((p) => p.id === id);
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

async function getMeta(key, fallback) {
  const m = await Store.get('meta', key);
  return m ? m.value : fallback;
}
async function setMeta(key, value) {
  await Store.put('meta', { key, value });
}

// ---------------- Data loading ----------------
async function loadAll() {
  const [profiles, exercises, routines, sessions, sets] = await Promise.all([
    Store.getAll('profiles'),
    Store.getAll('exercises'),
    Store.getAll('routines'),
    Store.getAll('sessions'),
    Store.getAll('sets'),
  ]);
  state.profiles = profiles.sort((a, b) => a.createdAt - b.createdAt);
  state.exercises = exercises.sort((a, b) => a.name.localeCompare(b.name));
  state.routines = routines;
  state.sessions = sessions.sort((a, b) => b.date.localeCompare(a.date));
  state.sets = sets;

  if (!state.activeProfileId && state.profiles.length) {
    const preferred = state.profiles.find((p) => p.id === state._lastActiveProfileId);
    state.activeProfileId = preferred ? preferred.id : state.profiles[0].id;
  }
}

function reconstructActiveSession(profileId) {
  const inProgress = state.sessions.find((s) => s.profileId === profileId && s.status === 'in_progress');
  if (!inProgress) return null;
  const exerciseIds = inProgress.exerciseIds || [];
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
    exercises,
  };
}

async function switchProfile(id) {
  state.activeProfileId = id;
  state._lastActiveProfileId = id;
  await setMeta('lastActiveProfileId', id);
  state.activeSession = reconstructActiveSession(id);
  render();
}

// ---------------- Init ----------------
async function init() {
  await seedIfEmpty();
  state.unit = await getMeta('unitPreference', 'lbs');
  state._lastActiveProfileId = await getMeta('lastActiveProfileId', null);
  state.selectedLogDate = todayISO();

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
  if (forceScreen) {
    app.innerHTML = '';
    app.appendChild(forceScreen);
    return;
  }
  app.innerHTML = '';
  app.appendChild(headerBar());
  const main = document.createElement('main');
  main.className = 'screen';
  main.appendChild(screenFor(state.tab));
  app.appendChild(main);
  app.appendChild(tabBar());
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
        await Store.delete('profiles', p.id);
        if (state.activeProfileId === p.id) state.activeProfileId = null;
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
    const text = await file.text();
    try {
      const payload = JSON.parse(text);
      await importAllData(payload, { replace: false });
      await loadAll();
      state.activeSession = reconstructActiveSession(state.activeProfileId);
      render();
      alert('Backup imported.');
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    }
  };
  importBtn.onclick = () => fileInput.click();
  backupRow.appendChild(importBtn);
  backupRow.appendChild(fileInput);
  wrap.appendChild(backupRow);

  return wrap;
}

// ================= EXERCISES =================
function exercisesScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'Exercise library'));

  const list = el('div', 'list');
  state.exercises.forEach((ex) => {
    const row = el('div', 'list-row');
    row.appendChild(iconImg(ex.icon));
    row.appendChild(el('span', 'row-label', ex.name));
    const editBtn = el('button', 'icon-btn', '✎');
    editBtn.onclick = () => openExerciseModal(ex);
    row.appendChild(editBtn);
    list.appendChild(row);
  });
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
      id: existing ? existing.id : uid(),
      name,
      icon: selectedIcon,
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
      await Store.delete('exercises', existing.id);
      await loadAll();
      overlay.remove();
      render();
    };
    content.appendChild(delBtn);
  }

  const overlay = modal(content);
}

// ================= LOG =================
function logScreen() {
  const wrap = el('div', 'section');

  if (!state.activeSession) {
    wrap.appendChild(el('h2', 'section-title', 'Start a workout'));

    wrap.appendChild(el('div', 'field-label', 'Date'));
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'text-input';
    dateInput.value = state.selectedLogDate || todayISO();
    dateInput.onchange = () => { state.selectedLogDate = dateInput.value || todayISO(); };
    wrap.appendChild(dateInput);

    const startFreeform = el('button', 'btn primary', 'Start freeform workout');
    startFreeform.onclick = () => startSession(null, []);
    wrap.appendChild(startFreeform);

    wrap.appendChild(el('h2', 'section-title', 'Routines'));
    const list = el('div', 'list');
    state.routines.forEach((r) => {
      const row = el('div', 'list-row');
      row.appendChild(el('span', 'row-label', r.name));
      row.style.cursor = 'pointer';
      row.onclick = () => startSession(r.id, r.exerciseIds);
      const delBtn = el('button', 'icon-btn', '✕');
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

function openRoutineModal() {
  const content = el('div');
  content.appendChild(el('h3', 'modal-title', 'New routine'));
  const nameInput = document.createElement('input');
  nameInput.className = 'text-input';
  nameInput.placeholder = 'Routine name (e.g. Push Day)';
  content.appendChild(nameInput);

  const selected = new Set();
  const grid = el('div', 'exercise-select-list');
  state.exercises.forEach((ex) => {
    const row = el('button', 'select-row');
    row.appendChild(iconImg(ex.icon, 24));
    row.appendChild(el('span', 'row-label', ex.name));
    row.onclick = () => {
      if (selected.has(ex.id)) { selected.delete(ex.id); row.classList.remove('selected'); }
      else { selected.add(ex.id); row.classList.add('selected'); }
    };
    grid.appendChild(row);
  });
  content.appendChild(grid);

  const saveBtn = el('button', 'btn primary', 'Save routine');
  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name || selected.size === 0) { alert('Name the routine and pick at least one exercise.'); return; }
    await Store.put('routines', { id: uid(), name, exerciseIds: [...selected], createdAt: Date.now() });
    await loadAll();
    overlay.remove();
    render();
  };
  content.appendChild(saveBtn);
  const overlay = modal(content);
}

// ---- Active session: persistence-backed lifecycle ----
async function startSession(routineId, exerciseIds) {
  const now = Date.now();
  const session = {
    id: uid(),
    profileId: state.activeProfileId,
    date: state.selectedLogDate || todayISO(),
    routineId: routineId || null,
    status: 'in_progress',
    exerciseIds: exerciseIds ? [...exerciseIds] : [],
    createdAt: now,
  };
  await Store.put('sessions', session);
  state.activeSession = {
    id: session.id,
    date: session.date,
    routineId: session.routineId,
    createdAt: now,
    exercises: (exerciseIds || []).map((eid) => ({ exerciseId: eid, sets: [] })),
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
  });
}

async function addExerciseToActiveSession(exerciseId) {
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

async function addSetToExercise(exEntry) {
  const last = exEntry.sets[exEntry.sets.length - 1];
  const newSet = {
    id: uid(),
    profileId: state.activeProfileId,
    sessionId: state.activeSession.id,
    exerciseId: exEntry.exerciseId,
    date: state.activeSession.date,
    setNumber: exEntry.sets.length + 1,
    weight: last ? last.weight : 0,
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
  render();
}

function activeSessionView() {
  const session = state.activeSession;
  const wrap = el('div', 'section');

  const topRow = el('div', 'session-top');
  const isToday = session.date === todayISO();
  topRow.appendChild(el('h2', 'section-title', isToday ? 'Today\u2019s workout' : `Workout \u2014 ${fmtDate(session.date)}`));
  const finishBtn = el('button', 'btn primary small', 'Finish');
  finishBtn.onclick = () => finishSession();
  topRow.appendChild(finishBtn);
  wrap.appendChild(topRow);

  session.exercises.forEach((exEntry, exIdx) => {
    const ex = exerciseById(exEntry.exerciseId);
    if (!ex) return;
    const card = el('div', 'exercise-card');
    const head = el('div', 'exercise-card-head');
    head.appendChild(iconImg(ex.icon));
    head.appendChild(el('span', 'row-label', ex.name));
    const removeExBtn = el('button', 'icon-btn', '✕');
    removeExBtn.onclick = () => removeExerciseFromActiveSession(exIdx);
    head.appendChild(removeExBtn);
    card.appendChild(head);

    const setsList = el('div', 'sets-list');
    const setHeaderRow = el('div', 'set-row set-header');
    setHeaderRow.appendChild(el('span', 'set-col', 'Set'));
    setHeaderRow.appendChild(el('span', 'set-col', `Weight (${state.unit})`));
    setHeaderRow.appendChild(el('span', 'set-col', 'Reps'));
    setHeaderRow.appendChild(el('span', 'set-col', ''));
    setsList.appendChild(setHeaderRow);

    exEntry.sets.forEach((s, setIdx) => {
      const row = el('div', 'set-row');
      row.appendChild(el('span', 'set-col', String(setIdx + 1)));

      const weightInput = document.createElement('input');
      weightInput.type = 'number';
      weightInput.inputMode = 'decimal';
      weightInput.className = 'set-input';
      weightInput.value = roundNice(toDisplay(s.weight));
      weightInput.onchange = async () => {
        const entered = parseFloat(weightInput.value) || 0;
        s.weight = toStoredLbs(entered, state.unit);
        await persistSet(s);
      };
      const wCol = el('span', 'set-col'); wCol.appendChild(weightInput);
      row.appendChild(wCol);

      const repsInput = document.createElement('input');
      repsInput.type = 'number';
      repsInput.inputMode = 'numeric';
      repsInput.className = 'set-input';
      repsInput.value = s.reps;
      repsInput.onchange = async () => {
        s.reps = parseInt(repsInput.value) || 0;
        await persistSet(s);
      };
      const rCol = el('span', 'set-col'); rCol.appendChild(repsInput);
      row.appendChild(rCol);

      const delSetBtn = el('button', 'icon-btn small', '✕');
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
    const grid = el('div', 'exercise-select-list');
    state.exercises.forEach((ex) => {
      const row = el('button', 'select-row');
      row.appendChild(iconImg(ex.icon, 24));
      row.appendChild(el('span', 'row-label', ex.name));
      row.onclick = async () => {
        overlay.remove();
        await addExerciseToActiveSession(ex.id);
      };
      grid.appendChild(row);
    });
    content.appendChild(grid);
    const overlay = modal(content);
  };
  wrap.appendChild(addExerciseBtn);

  const cancelBtn = el('button', 'btn danger', 'Cancel workout');
  cancelBtn.onclick = () => cancelActiveSession(false);
  wrap.appendChild(cancelBtn);

  return wrap;
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
  state.activeSession = null;
  await loadAll();
  render();
}

async function finishSession() {
  const session = state.activeSession;
  const hasSets = session.exercises.some((e) => e.sets.length > 0);
  if (!hasSets) {
    if (!confirm('No sets logged. Discard this workout?')) return;
    await cancelActiveSession(true);
    return;
  }

  await Store.put('sessions', {
    id: session.id,
    profileId: state.activeProfileId,
    date: session.date,
    routineId: session.routineId,
    status: 'completed',
    exerciseIds: session.exercises.map((e) => e.exerciseId),
    createdAt: session.createdAt || Date.now(),
    completedAt: Date.now(),
  });

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
    const exerciseIds = [...new Set(sessionSets.map((s) => s.exerciseId))];
    const totalVolumeLbs = sessionSets.reduce((sum, s) => sum + s.weight * s.reps, 0);

    const row = el('div', 'history-row');
    row.style.cursor = 'pointer';
    row.onclick = () => openWorkoutDetailModal(session);

    const dateRow = el('div', 'history-date-row');
    dateRow.appendChild(el('span', 'history-date', fmtDate(session.date)));
    dateRow.appendChild(el('span', 'history-volume', `${roundNice(toDisplay(totalVolumeLbs)).toLocaleString()} ${state.unit} vol`));
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
  const exerciseIds = [...new Set(sessionSets.map((s) => s.exerciseId))];
  const totalVolumeLbs = sessionSets.reduce((sum, s) => sum + s.weight * s.reps, 0);

  content.appendChild(el('p', 'field-hint', `Total volume: ${roundNice(toDisplay(totalVolumeLbs)).toLocaleString()} ${state.unit}`));

  exerciseIds.forEach((eid) => {
    const ex = exerciseById(eid);
    const exSets = sessionSets.filter((s) => s.exerciseId === eid).sort((a, b) => (a.setNumber || 0) - (b.setNumber || 0));
    const exVolumeLbs = exSets.reduce((sum, s) => sum + s.weight * s.reps, 0);

    const card = el('div', 'exercise-card');
    const head = el('div', 'exercise-card-head');
    head.appendChild(iconImg(ex ? ex.icon : 'barbell-generic'));
    head.appendChild(el('span', 'row-label', ex ? ex.name : 'Deleted exercise'));
    card.appendChild(head);

    const setsList = el('div', 'sets-list');
    const setHeaderRow = el('div', 'set-row set-header');
    setHeaderRow.appendChild(el('span', 'set-col', 'Set'));
    setHeaderRow.appendChild(el('span', 'set-col', `Weight (${state.unit})`));
    setHeaderRow.appendChild(el('span', 'set-col', 'Reps'));
    setsList.appendChild(setHeaderRow);

    exSets.forEach((s, idx) => {
      const row = el('div', 'set-row read-only');
      row.appendChild(el('span', 'set-col', String(idx + 1)));
      row.appendChild(el('span', 'set-col', String(roundNice(toDisplay(s.weight)))));
      row.appendChild(el('span', 'set-col', String(s.reps)));
      setsList.appendChild(row);
    });
    card.appendChild(setsList);
    card.appendChild(el('p', 'field-hint', `Exercise volume: ${roundNice(toDisplay(exVolumeLbs)).toLocaleString()} ${state.unit}`));

    content.appendChild(card);
  });

  modal(content);
}

// ================= PROGRESS =================
function rangeStartDate(range) {
  if (range === '7d') return isoDaysAgo(7);
  if (range === '30d') return isoDaysAgo(30);
  if (range === '1y') return isoDaysAgo(365);
  if (range === 'ytd') return `${new Date().getFullYear()}-01-01`;
  return null; // all
}

function aggregateByDate(sets, metric) {
  const byDate = {};
  sets.forEach((s) => {
    const val = metric === 'weight' ? s.weight : s.weight * s.reps;
    if (!(s.date in byDate)) byDate[s.date] = metric === 'weight' ? -Infinity : 0;
    byDate[s.date] = metric === 'weight' ? Math.max(byDate[s.date], val) : byDate[s.date] + val;
  });
  return byDate;
}

function computePctChange() {
  const rangeStart = rangeStartDate(state.progressRange);
  let sets = state.sets.filter((s) => s.profileId === state.activeProfileId && s.exerciseId === state.progressExerciseId);
  if (rangeStart) sets = sets.filter((s) => s.date >= rangeStart);
  if (sets.length === 0) return null;

  const byDate = aggregateByDate(sets, state.progressMetric);
  const dates = Object.keys(byDate).sort();
  if (dates.length < 2) return null;

  const first = byDate[dates[0]];
  const last = byDate[dates[dates.length - 1]];
  if (!first) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

function progressScreen() {
  const wrap = el('div', 'section');
  wrap.appendChild(el('h2', 'section-title', 'Progress'));

  if (state.exercises.length === 0) {
    wrap.appendChild(el('p', 'empty-state', 'Add exercises first to see progress.'));
    return wrap;
  }

  if (!state.progressExerciseId) state.progressExerciseId = state.exercises[0].id;
  if (state.progressProfileIds.length === 0) state.progressProfileIds = [state.activeProfileId];

  const exSelect = document.createElement('select');
  exSelect.className = 'select-input';
  state.exercises.forEach((ex) => {
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = ex.name;
    if (ex.id === state.progressExerciseId) opt.selected = true;
    exSelect.appendChild(opt);
  });
  exSelect.onchange = () => { state.progressExerciseId = exSelect.value; render(); };
  wrap.appendChild(exSelect);

  const metricRow = el('div', 'btn-row');
  ['weight', 'volume'].forEach((m) => {
    const btn = el('button', 'btn small ' + (state.progressMetric === m ? 'primary' : 'secondary'), m === 'weight' ? 'Weight' : 'Volume');
    btn.onclick = () => { state.progressMetric = m; render(); };
    metricRow.appendChild(btn);
  });
  wrap.appendChild(metricRow);

  const rangeRow = el('div', 'btn-row wrap');
  RANGES.forEach(([val, label]) => {
    const btn = el('button', 'btn small ' + (state.progressRange === val ? 'primary' : 'secondary'), label);
    btn.onclick = () => { state.progressRange = val; render(); };
    rangeRow.appendChild(btn);
  });
  wrap.appendChild(rangeRow);

  const pct = computePctChange();
  if (pct !== null) {
    const positive = pct >= 0;
    const ticker = el('div', 'pct-ticker ' + (positive ? 'positive' : 'negative'));
    ticker.textContent = `${positive ? '\u25B2' : '\u25BC'} ${Math.abs(pct).toFixed(1)}%`;
    wrap.appendChild(ticker);
  }

  if (state.profiles.length > 1) {
    wrap.appendChild(el('div', 'field-label', 'Compare users'));
    const userRow = el('div', 'btn-row wrap');
    state.profiles.forEach((p) => {
      const active = state.progressProfileIds.includes(p.id);
      const btn = el('button', 'chip-toggle' + (active ? ' active' : ''));
      btn.style.setProperty('--chip-color', p.color);
      btn.textContent = p.name;
      btn.onclick = () => {
        if (active) {
          state.progressProfileIds = state.progressProfileIds.filter((id) => id !== p.id);
        } else {
          state.progressProfileIds = [...state.progressProfileIds, p.id];
        }
        render();
      };
      userRow.appendChild(btn);
    });
    wrap.appendChild(userRow);
  }

  const canvasWrap = el('div', 'chart-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'progressChart';
  canvasWrap.appendChild(canvas);
  wrap.appendChild(canvasWrap);

  const mySets = state.sets.filter((s) => s.profileId === state.activeProfileId);
  const mySessions = state.sessions.filter((s) => s.profileId === state.activeProfileId && isCompleted(s));
  const totalVolumeLbs = mySets.reduce((sum, s) => sum + s.weight * s.reps, 0);
  const statsRow = el('div', 'stats-row');
  statsRow.appendChild(statCard('Workouts', mySessions.length));
  statsRow.appendChild(statCard(`Total volume (${state.unit})`, roundNice(toDisplay(totalVolumeLbs)).toLocaleString()));
  wrap.appendChild(statsRow);

  const exSets = mySets.filter((s) => s.exerciseId === state.progressExerciseId);
  if (exSets.length > 0) {
    const maxWeightLbs = Math.max(...exSets.map((s) => s.weight));
    wrap.appendChild(el('p', 'pr-badge', `\uD83C\uDFC6 PR: ${roundNice(toDisplay(maxWeightLbs))} ${state.unit} on ${exerciseById(state.progressExerciseId).name}`));
  }

  requestAnimationFrame(() => drawProgressChart(canvas));

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
  const exerciseId = state.progressExerciseId;
  const metric = state.progressMetric;
  const rangeStart = rangeStartDate(state.progressRange);

  const datasets = state.progressProfileIds.map((pid) => {
    const profile = profileById(pid);
    let sets = state.sets.filter((s) => s.profileId === pid && s.exerciseId === exerciseId);
    if (rangeStart) sets = sets.filter((s) => s.date >= rangeStart);
    sets = sets.sort((a, b) => a.date.localeCompare(b.date));

    const byDate = aggregateByDate(sets, metric);
    const points = Object.keys(byDate).sort().map((d) => ({ x: d, y: roundNice(toDisplay(byDate[d])) }));
    return {
      label: profile ? profile.name : 'Unknown',
      data: points,
      borderColor: profile ? profile.color : '#38bdf8',
      backgroundColor: profile ? profile.color : '#38bdf8',
      tension: 0.25,
    };
  });

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: '#e2e8f0' } },
      },
      scales: {
        x: { type: 'time', time: { unit: 'day' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, title: { display: true, text: state.unit, color: '#94a3b8' } },
      },
    },
  });
}

// ---------------- Start ----------------
init();
