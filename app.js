'use strict';
/* ==========================================================================
   CHARGER — app.js
   Vanilla JS. No frameworks, no backend, no build step.
   Organized in clearly commented sections — read top to bottom.
   ========================================================================== */

/* ============================================================
   0. TINY DOM / GENERAL HELPERS
   ============================================================ */
const qs  = (s, el = document) => el.querySelector(s);
const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));
const on  = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayStr = (d = new Date()) => {
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
};
const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtMin = (m) => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm}m` : `${mm}m`; };

// Event delegation: bind once on a stable parent, handle clicks/changes on children that get re-rendered.
function delegate(container, selector, event, handler) {
  if (!container) return;
  on(container, event, (e) => {
    const target = e.target.closest(selector);
    if (target && container.contains(target)) handler(target, e);
  });
}

/* ============================================================
   1. STORAGE — localStorage generic array stores
   ============================================================ */
const SCHEMA_VERSION = 1;

function lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch (e) { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { console.warn('storage write failed', e); toast('Storage is full — export a backup and consider clearing old data.', 'bad'); }
}

function Store(key, def = []) {
  return {
    all() { return lsGet(key, def); },
    save(arr) { lsSet(key, arr); return arr; },
    add(item) { const arr = this.all(); arr.push(item); this.save(arr); return item; },
    update(id, patch) { const arr = this.all(); const i = arr.findIndex(x => x.id === id); if (i > -1) { arr[i] = { ...arr[i], ...patch }; this.save(arr); } return arr[i]; },
    remove(id) { this.save(this.all().filter(x => x.id !== id)); },
    get(id) { return this.all().find(x => x.id === id); }
  };
}

const TasksStore       = Store('charger_tasks');
const GoalsStore       = Store('charger_goals');
const HabitsStore      = Store('charger_habits');
const AlarmsStore      = Store('charger_alarms');
const RemindersStore   = Store('charger_reminders');
const EventsStore      = Store('charger_events');
const BooksStore       = Store('charger_books');
const RoutinesStore    = Store('charger_routines');
const SubjectsStore    = Store('charger_subjects');
const DistractionsStore= Store('charger_distractions');
const ReviewsStore     = Store('charger_reviews');
const HealthLogStore   = Store('charger_health');
const EnergyLogStore   = Store('charger_energy');

function SettingsAPI() {
  const def = {
    accent: 'cyan', schemaVersion: SCHEMA_VERSION,
    soundMasterMute: false, uiClickSound: false, notifSound: true,
    weeklyReviewDay: 0, defaultPomoFocus: 25, defaultPomoBreak: 5,
    dailyFocusGoalMin: 120, lastBackupPrompt: Date.now(), onboarded: false,
    dashboardLayout: null
  };
  let cur = { ...def, ...lsGet('charger_settings', {}) };
  return {
    get() { return cur; },
    set(patch) { cur = { ...cur, ...patch }; lsSet('charger_settings', cur); return cur; }
  };
}
const AppSettings = SettingsAPI();

/* ============================================================
   2. INDEXEDDB — larger structured data (notes, flashcards, time logs, journal)
   Loaded into an in-memory cache at boot; writes go through to IDB async
   while render code reads/writes the synchronous in-memory cache.
   ============================================================ */
const IDB_NAME = 'chargerDB', IDB_VERSION = 1;
const IDB_STORES = ['notes', 'flashcards', 'timelogs', 'journal'];
let idbInstance = null;
const Cache = { notes: [], flashcards: [], timelogs: [], journal: [] };

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject('no indexeddb'); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      IDB_STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}
function idbAll(store) {
  return new Promise((resolve) => {
    if (!idbInstance) { resolve([]); return; }
    try {
      const req = idbInstance.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}
function idbPut(store, item) { if (!idbInstance) return; try { idbInstance.transaction(store, 'readwrite').objectStore(store).put(item); } catch (e) {} }
function idbDelete(store, id) { if (!idbInstance) return; try { idbInstance.transaction(store, 'readwrite').objectStore(store).delete(id); } catch (e) {} }

function MemStore(storeName) {
  return {
    all() { return Cache[storeName]; },
    add(item) { Cache[storeName].push(item); idbPut(storeName, item); return item; },
    update(id, patch) { const arr = Cache[storeName]; const i = arr.findIndex(x => x.id === id); if (i > -1) { arr[i] = { ...arr[i], ...patch }; idbPut(storeName, arr[i]); } return arr[i]; },
    remove(id) { Cache[storeName] = Cache[storeName].filter(x => x.id !== id); idbDelete(storeName, id); },
    get(id) { return Cache[storeName].find(x => x.id === id); }
  };
}
const NotesStore   = MemStore('notes');
const FlashStore   = MemStore('flashcards');
const TimeLogStore = MemStore('timelogs');
const JournalStore = MemStore('journal');

/* ============================================================
   3. GAMIFICATION — cross-feature XP & levels (cosmetic only)
   ============================================================ */
function XPApi() {
  let data = lsGet('charger_xp', { total: 0, unlockedThemes: ['cyan', 'magenta'] });
  const levelFromXP = (xp) => Math.floor(Math.sqrt(xp / 20)) + 1;
  const xpForLevel  = (lvl) => Math.pow(lvl - 1, 2) * 20;
  return {
    data() { return data; },
    level() { return levelFromXP(data.total); },
    progress() {
      const lvl = levelFromXP(data.total);
      const floorXP = xpForLevel(lvl), nextXP = xpForLevel(lvl + 1);
      return { pct: clamp(((data.total - floorXP) / (nextXP - floorXP)) * 100, 0, 100), total: data.total };
    },
    add(amount, reason) {
      const before = levelFromXP(data.total);
      data.total += amount;
      lsSet('charger_xp', data);
      const after = levelFromXP(data.total);
      renderXPMini();
      toast(`+${amount} XP — ${reason}`, 'good');
      if (after > before) {
        toast(`Level up! You're now level ${after}.`, 'good');
        unlockThemeCheck(after);
      }
    }
  };
}
const Gamify = XPApi();

const THEME_ACCENTS = { cyan: '#33f0e0', magenta: '#ff3fc4', gold: '#ffcc4d', violet: '#b088ff' };
function applyAccent(name) {
  document.documentElement.style.setProperty('--cyan', THEME_ACCENTS[name] || THEME_ACCENTS.cyan);
  AppSettings.set({ accent: name });
}
function unlockThemeCheck(level) {
  const d = Gamify.data();
  const unlocks = { 3: 'gold', 6: 'violet' };
  const t = unlocks[level];
  if (t && !d.unlockedThemes.includes(t)) {
    d.unlockedThemes.push(t);
    lsSet('charger_xp', d);
    toast(`New cosmetic theme unlocked: ${t}`, 'good');
  }
}

/* ============================================================
   4. TOASTS / MODAL
   ============================================================ */
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeftColor = kind === 'good' ? 'var(--good)' : kind === 'bad' ? 'var(--bad)' : 'var(--cyan)';
  el.textContent = msg;
  qs('#toastStack').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function openModal(html, onMount) {
  qs('#modalCard').innerHTML = html;
  qs('#modalOverlay').classList.remove('hidden');
  if (onMount) onMount(qs('#modalCard'));
}
function closeModal() { qs('#modalOverlay').classList.add('hidden'); qs('#modalCard').innerHTML = ''; }
on(qs('#modalOverlay'), 'click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

/* ============================================================
   5. SOUND SYSTEM — Web Audio generated tones + ambient noise
      (no external audio files — everything generated locally, fully offline)
   ============================================================ */
let audioCtx = null;
const activeSoundNodes = {};
const SOUND_DEFS = [
  { id: 'rain',      label: 'Rain',         icon: '🌧️', filter: 'lowpass',  freq: 1200 },
  { id: 'forest',    label: 'Forest',       icon: '🌲', filter: 'bandpass', freq: 800 },
  { id: 'ocean',     label: 'Ocean',        icon: '🌊', filter: 'lowpass',  freq: 350 },
  { id: 'wind',      label: 'Wind',         icon: '🍃', filter: 'highpass', freq: 300 },
  { id: 'library',   label: 'Library Hum',  icon: '📖', filter: 'lowpass',  freq: 180 },
  { id: 'fireplace', label: 'Fireplace',    icon: '🔥', filter: 'lowpass',  freq: 500 },
  { id: 'brown',     label: 'Brown Noise',  icon: '∿',  brown: true }
];
function ensureAudioCtx() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
function makeNoiseBuffer(ctx, brown) {
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) { lastOut = (lastOut + 0.02 * white) / 1.02; data[i] = lastOut * 3.5; }
    else data[i] = white;
  }
  return buffer;
}
function playSound(id) {
  const def = SOUND_DEFS.find(s => s.id === id); if (!def) return;
  stopSound(id);
  const ctx = ensureAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = makeNoiseBuffer(ctx, !!def.brown);
  source.loop = qs('#soundLoop').checked;
  let node = source;
  if (def.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = def.filter; filter.frequency.value = def.freq;
    node.connect(filter); node = filter;
  }
  const gain = ctx.createGain();
  gain.gain.value = AppSettings.get().soundMasterMute ? 0 : (qs('#soundVolume').value / 100);
  node.connect(gain); gain.connect(ctx.destination);
  source.start();
  activeSoundNodes[id] = { source, gain };
  source.onended = () => { delete activeSoundNodes[id]; qsa('.sound-tile').forEach(t => { if (t.dataset.id === id) t.classList.remove('playing'); }); };
}
function stopSound(id) { const n = activeSoundNodes[id]; if (n) { try { n.source.stop(); } catch (e) {} delete activeSoundNodes[id]; } }
function stopAllSounds() { Object.keys(activeSoundNodes).forEach(stopSound); }

function playEventSound(urgent = false) {
  if (AppSettings.get().soundMasterMute || !AppSettings.get().notifSound) return;
  const ctx = ensureAudioCtx();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = urgent ? 880 : 660; o.type = 'sine';
  g.gain.value = 0.0001;
  o.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (urgent ? 0.6 : 0.35));
  o.start(t); o.stop(t + (urgent ? 0.7 : 0.4));
  if (urgent) setTimeout(() => playEventSound(false), 700);
}
function playClickSound() {
  if (!AppSettings.get().uiClickSound || AppSettings.get().soundMasterMute) return;
  const ctx = ensureAudioCtx();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 1200; g.gain.value = 0.0006;
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.04);
}
document.addEventListener('click', (e) => { if (e.target.closest('button, .nav-link, .seg-btn')) playClickSound(); });

function notify(msg) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Charger', { body: msg }); } catch (e) {}
  }
}

/* ============================================================
   6. ROUTER
   ============================================================ */
const VIEWS = ['dashboard', 'tasks', 'study', 'pomodoro', 'sounds', 'alarms', 'goals', 'habits', 'timeaudit', 'reviews', 'analytics', 'calendar', 'books', 'life', 'discipline', 'settings'];

function navigateTo(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  VIEWS.forEach(v => qs('#view-' + v).classList.toggle('hidden', v !== view));
  qsa('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  qs('#topbarTitle').textContent = view.charAt(0).toUpperCase() + view.slice(1);
  if (location.hash.slice(1) !== view) location.hash = view;
  qs('#sidebar').classList.remove('open');
  renderView(view);
}
function renderView(view) {
  ({
    dashboard: renderDashboard, tasks: renderTasks, study: renderStudy, pomodoro: renderPomodoroView,
    sounds: renderSounds, alarms: renderAlarms, goals: renderGoals, habits: renderHabits,
    timeaudit: renderTimeAudit, reviews: renderReviews, analytics: renderAnalytics, calendar: renderCalendar,
    books: renderBooks, life: renderLife, discipline: renderDiscipline, settings: renderSettings
  }[view] || renderDashboard)();
}
on(window, 'hashchange', () => navigateTo(location.hash.slice(1)));
qsa('.nav-link').forEach(a => on(a, 'click', (e) => { e.preventDefault(); navigateTo(a.dataset.view); }));
on(qs('#menuToggle'), 'click', () => qs('#sidebar').classList.toggle('open'));

/* ============================================================
   7. DASHBOARD
   ============================================================ */
const DASHBOARD_WIDGETS = [
  { id: 'mit', title: "Today's Most Important Task" },
  { id: 'today', title: 'Today Overview' },
  { id: 'timeaudit', title: 'Time Audit' },
  { id: 'focusscore', title: 'Focus Score' },
  { id: 'rhythm', title: 'Personal Rhythm' },
  { id: 'revision', title: 'Revision Queue' },
  { id: 'reminders', title: 'Upcoming Reminders' }
];
function getDashboardLayout() {
  let layout = AppSettings.get().dashboardLayout;
  if (!layout || !layout.length) { layout = DASHBOARD_WIDGETS.map(w => ({ id: w.id, visible: true })); AppSettings.set({ dashboardLayout: layout }); }
  DASHBOARD_WIDGETS.forEach(w => { if (!layout.find(l => l.id === w.id)) layout.push({ id: w.id, visible: true }); });
  return layout;
}
function greetingText() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
}
function renderDashboard() {
  qs('#greeting').textContent = greetingText();
  const layout = getDashboardLayout();
  const grid = qs('#dashboardGrid');
  grid.innerHTML = layout.filter(l => l.visible).map(l => {
    const w = DASHBOARD_WIDGETS.find(x => x.id === l.id);
    if (!w) return '';
    return `<div class="card widget" draggable="true" data-widget="${w.id}">
      <div class="widget-title"><span class="widget-drag-handle">⠿</span> ${w.title}</div>
      <div class="widget-body" id="wb-${w.id}"></div>
    </div>`;
  }).join('');
  layout.forEach(l => { if (l.visible) renderWidgetBody(l.id); });
  attachWidgetDragHandlers();
}
function renderWidgetBody(id) {
  ({ mit: renderMitWidget, today: renderTodayWidget, timeaudit: renderTimeAuditWidget, focusscore: renderFocusScoreWidget,
     rhythm: renderRhythmWidget, revision: renderRevisionWidget, reminders: renderRemindersWidget }[id] || (() => {}))();
}
function renderMitWidget() {
  const el = qs('#wb-mit'); if (!el) return;
  const today = todayStr();
  const mits = TasksStore.all().filter(t => t.isMIT && t.mitDate === today);
  el.innerHTML = mits.length
    ? mits.map(t => `<div class="list-item ${t.done ? 'done' : ''}" data-id="${t.id}"><input type="checkbox" class="task-done-cb" ${t.done ? 'checked' : ''}><div class="li-title">${escapeHtml(t.title)}</div></div>`).join('')
    : `<p class="muted">No MIT set for today. <a href="#tasks" class="dash-link">Set one →</a></p>`;
}
function renderTodayWidget() {
  const el = qs('#wb-today'); if (!el) return;
  const today = todayStr();
  const tasksToday = TasksStore.all().filter(t => t.deadline === today);
  const doneToday = tasksToday.filter(t => t.done).length;
  const habits = HabitsStore.all();
  const habitsDone = habits.filter(h => h.history && h.history[today] === 'done').length;
  const pomo = getPomoData().sessions.filter(s => s.date === today && s.type === 'focus' && s.completed).length;
  el.innerHTML = `<p>✓ Tasks: ${doneToday}/${tasksToday.length}</p><p>🔥 Habits: ${habitsDone}/${habits.length}</p><p>◷ Pomodoros: ${pomo}</p>`;
}
function renderTimeAuditWidget() {
  const el = qs('#wb-timeaudit'); if (!el) return;
  const today = todayStr();
  const logs = TimeLogStore.all().filter(l => l.date === today);
  const total = logs.reduce((s, l) => s + l.minutes, 0);
  const deep = logs.filter(l => l.category === 'Deep Work').reduce((s, l) => s + l.minutes, 0);
  const goal = AppSettings.get().dailyFocusGoalMin || 120;
  el.innerHTML = `<p>${fmtMin(deep)} deep work / ${fmtMin(goal)} goal</p><div class="xp-bar"><div class="xp-bar-fill" style="width:${clamp(deep / goal * 100, 0, 100)}%"></div></div><p class="muted" style="margin-top:8px">${fmtMin(total)} logged today overall</p>`;
}
function renderFocusScoreWidget() {
  const el = qs('#wb-focusscore'); if (!el) return;
  el.innerHTML = `<div style="font-family:var(--font-display);font-size:2.2rem">${focusScoreForDate(todayStr())}</div><p class="muted">out of 100</p>`;
}
function renderRevisionWidget() {
  const el = qs('#wb-revision'); if (!el) return;
  const queue = getRevisionQueue();
  el.innerHTML = queue.length ? `<p>${queue.length} item(s) due today.</p><a href="#study" class="dash-link muted">Open revision queue →</a>` : '<p class="muted">Nothing due today.</p>';
}
function renderRemindersWidget() {
  const el = qs('#wb-reminders'); if (!el) return;
  const items = [];
  AlarmsStore.all().filter(a => a.enabled).forEach(a => items.push(`⏰ ${a.label} — ${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}`));
  RemindersStore.all().filter(r => r.enabled).forEach(r => items.push(`🔔 ${r.text} — ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`));
  el.innerHTML = items.length ? items.slice(0, 5).map(i => `<p>${i}</p>`).join('') : '<p class="muted">No alarms or reminders set.</p>';
}
function renderRhythmWidget() {
  const el = qs('#wb-rhythm'); if (!el) return;
  el.innerHTML = `<canvas id="rhythmCanvas" style="width:100%;height:90px"></canvas><p class="muted" style="font-size:0.72rem">Deep-work minutes by hour today, energy check-ins overlaid.</p>`;
  const data = personalRhythmData();
  drawLineChart(qs('#rhythmCanvas'), data.map(d => d.h % 3 === 0 ? d.h + ':00' : ''), data.map(d => d.deep));
}
function personalRhythmData() {
  const today = todayStr();
  const hours = [...Array(24)].map((_, h) => ({ h, deep: 0 }));
  TimeLogStore.all().filter(l => l.date === today && typeof l.hour === 'number').forEach(l => { if (l.category === 'Deep Work' && hours[l.hour]) hours[l.hour].deep += l.minutes; });
  return hours;
}
function completeTaskToggle(id, checked) {
  TasksStore.update(id, { done: checked, doneAt: checked ? todayStr() : null });
  if (checked) Gamify.add(5, 'Task completed');
  renderTasks(); renderDashboard();
}
delegate(qs('#dashboardGrid'), '.task-done-cb', 'change', (cb) => completeTaskToggle(cb.closest('.list-item').dataset.id, cb.checked));
on(qs('#startFocusCta'), 'click', () => { navigateTo('pomodoro'); pomoStartTimer(); });

function attachWidgetDragHandlers() {
  const grid = qs('#dashboardGrid');
  let dragEl = null;
  qsa('.widget', grid).forEach(w => {
    on(w, 'dragstart', () => { dragEl = w; setTimeout(() => w.style.opacity = '0.4', 0); });
    on(w, 'dragend', () => { w.style.opacity = '1'; saveWidgetOrder(); });
    on(w, 'dragover', (e) => {
      e.preventDefault();
      const after = getDragAfterElement(grid, e.clientY);
      if (!dragEl) return;
      if (after == null) grid.appendChild(dragEl); else grid.insertBefore(dragEl, after);
    });
  });
}
function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.widget')].filter(el => el.style.opacity !== '0.4');
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
  }, { offset: -Infinity }).element;
}
function saveWidgetOrder() {
  const order = qsa('#dashboardGrid .widget').map(w => w.dataset.widget);
  const layout = getDashboardLayout();
  layout.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  AppSettings.set({ dashboardLayout: layout });
}

/* ============================================================
   8. TASKS — MIT, Eisenhower matrix, inbox / quick capture
   ============================================================ */
let currentTaskView = 'today';
function taskItemHtml(t) {
  const overdue = t.deadline && t.deadline < todayStr() && !t.done;
  return `<div class="list-item ${t.done ? 'done' : ''}" data-id="${t.id}">
    <input type="checkbox" class="task-done-cb" ${t.done ? 'checked' : ''}>
    <div class="li-title">${escapeHtml(t.title)}</div>
    <div class="li-meta">
      <span class="tag tag-${t.priority}">${t.priority}</span>
      ${t.category ? `<span class="tag">${escapeHtml(t.category)}</span>` : ''}
      ${t.deadline ? `<span class="tag" style="${overdue ? 'color:var(--bad)' : ''}">${t.deadline}</span>` : ''}
      ${t.isMIT ? `<span class="mit-star">★ MIT</span>` : ''}
    </div>
    <button class="icon-btn task-mit-btn" title="Toggle MIT">${t.isMIT ? '★' : '☆'}</button>
    ${t.inbox && !t.sorted ? `<button class="btn btn-sm task-sort-btn">Sort</button>` : ''}
    <button class="icon-btn task-del-btn" title="Delete">✕</button>
  </div>`;
}
function renderMatrix(tasks) {
  const q = { do: [], schedule: [], delegate: [], eliminate: [] };
  tasks.forEach(t => {
    if (t.urgent && t.important) q.do.push(t);
    else if (!t.urgent && t.important) q.schedule.push(t);
    else if (t.urgent && !t.important) q.delegate.push(t);
    else q.eliminate.push(t);
  });
  const quad = (title, arr) => `<div class="matrix-quad"><h4>${title} (${arr.length})</h4>${arr.map(taskItemHtml).join('') || '<p class="muted" style="font-size:0.78rem">Empty</p>'}</div>`;
  return `<div class="matrix-grid">
    ${quad('Do now — Urgent &amp; Important', q.do)}
    ${quad('Schedule — Important', q.schedule)}
    ${quad('Delegate — Urgent', q.delegate)}
    ${quad('Eliminate — Neither', q.eliminate)}
  </div>`;
}
function renderMitBar() {
  const today = todayStr();
  const mits = TasksStore.all().filter(t => t.isMIT && t.mitDate === today && !t.done);
  qs('#mitBar').innerHTML = mits.map(t => `<div class="mit-chip">★ ${escapeHtml(t.title)}</div>`).join('');
}
function renderTasks() {
  qsa('#taskViewSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.taskview === currentTaskView));
  renderMitBar();
  const tasks = TasksStore.all();
  const today = todayStr();
  const container = qs('#taskListContainer');
  if (currentTaskView === 'matrix') { container.innerHTML = renderMatrix(tasks.filter(t => !t.done)); return; }
  let list;
  if (currentTaskView === 'today') list = tasks.filter(t => !t.done && (t.deadline === today || (t.isMIT && t.mitDate === today)));
  else if (currentTaskView === 'upcoming') list = tasks.filter(t => !t.done && t.deadline && t.deadline > today);
  else if (currentTaskView === 'completed') list = tasks.filter(t => t.done);
  else list = tasks.filter(t => t.inbox && !t.sorted);
  if (!list.length) { container.innerHTML = `<p class="muted">Nothing here yet.</p>`; return; }
  list = [...list].sort((a, b) => (b.priority === 'high') - (a.priority === 'high'));
  container.innerHTML = list.map(taskItemHtml).join('');
}
qsa('#taskViewSeg .seg-btn').forEach(b => on(b, 'click', () => { currentTaskView = b.dataset.taskview; renderTasks(); }));
on(qs('#taskForm'), 'submit', (e) => {
  e.preventDefault();
  TasksStore.add({
    id: uid(), title: qs('#taskTitle').value, priority: qs('#taskPriority').value, deadline: qs('#taskDeadline').value || null,
    category: qs('#taskCategory').value, difficulty: qs('#taskDifficulty').value, urgent: qs('#taskUrgent').checked, important: qs('#taskImportant').checked,
    done: false, createdAt: todayStr(), inbox: false, sorted: true
  });
  qs('#taskForm').reset(); renderTasks(); renderDashboard();
});
delegate(qs('#taskListContainer'), '.task-done-cb', 'change', (cb) => completeTaskToggle(cb.closest('.list-item').dataset.id, cb.checked));
delegate(qs('#taskListContainer'), '.task-mit-btn', 'click', (btn) => {
  const id = btn.closest('.list-item').dataset.id, t = TasksStore.get(id), today = todayStr();
  if (!t.isMIT) {
    if (TasksStore.all().filter(x => x.isMIT && x.mitDate === today).length >= 3) { toast('Max 3 MIT tasks per day.', 'bad'); return; }
    TasksStore.update(id, { isMIT: true, mitDate: today });
  } else TasksStore.update(id, { isMIT: false });
  renderTasks(); renderDashboard();
});
delegate(qs('#taskListContainer'), '.task-del-btn', 'click', (btn) => { TasksStore.remove(btn.closest('.list-item').dataset.id); renderTasks(); renderDashboard(); });
delegate(qs('#taskListContainer'), '.task-sort-btn', 'click', (btn) => {
  const id = btn.closest('.list-item').dataset.id, t = TasksStore.get(id);
  openModal(`<h3>Sort: ${escapeHtml(t.title)}</h3>
    <div class="inline-form">
      <select id="sortPriority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
      <input type="date" id="sortDeadline">
      <input type="text" id="sortCategory" placeholder="Category">
    </div>
    <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="sortSave">Save</button></div>`, (card) => {
    on(qs('#sortSave', card), 'click', () => {
      TasksStore.update(id, { priority: qs('#sortPriority', card).value, deadline: qs('#sortDeadline', card).value, category: qs('#sortCategory', card).value, sorted: true, inbox: false });
      closeModal(); renderTasks();
    });
  });
});

/* ============================================================
   9. STUDY — subjects/chapters, SRS engine, notes, flashcards
   ============================================================ */
function sm2(item, quality) {
  item.ease = Math.max(1.3, (item.ease || 2.5) + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  if (quality < 3) { item.repetition = 0; item.interval = 1; }
  else {
    item.repetition = (item.repetition || 0) + 1;
    if (item.repetition === 1) item.interval = 1;
    else if (item.repetition === 2) item.interval = 6;
    else item.interval = Math.round((item.interval || 1) * item.ease);
  }
  const due = new Date(); due.setDate(due.getDate() + item.interval);
  item.due = todayStr(due);
  item.lastReviewed = todayStr();
  item.reviewHistory = item.reviewHistory || [];
  item.reviewHistory.push({ date: todayStr(), quality });
  return item;
}
function getRevisionQueue() {
  const today = todayStr();
  const chapterItems = [];
  SubjectsStore.all().forEach(s => (s.chapters || []).forEach(ch => { if (ch.due && ch.due <= today) chapterItems.push({ kind: 'chapter', subjectId: s.id, subjectName: s.name, ...ch }); }));
  const flashItems = FlashStore.all().filter(f => f.due && f.due <= today).map(f => ({ kind: 'flashcard', ...f }));
  return [...chapterItems, ...flashItems];
}
function openSRSReviewModal(kind, parentId, itemId) {
  let item, frontHtml, saveFn;
  if (kind === 'chapter') {
    const s = SubjectsStore.get(parentId); item = s.chapters.find(c => c.id === itemId);
    frontHtml = `<h3>${escapeHtml(item.name)}</h3><p class="muted">How well do you remember this chapter?</p>
      <label>Understanding now: <input type="range" id="srsUnderstanding" min="0" max="100" value="${item.understanding || 50}"></label>`;
    saveFn = (quality, understanding) => { sm2(item, quality); item.understanding = understanding; SubjectsStore.update(parentId, { chapters: s.chapters }); };
  } else {
    item = FlashStore.get(itemId);
    frontHtml = `<div class="flash-flip" id="flashFlip">${escapeHtml(item.front)}</div><p class="muted" style="margin-top:8px">Tap the card to flip.</p>`;
    saveFn = (quality) => { sm2(item, quality); FlashStore.update(itemId, item); };
  }
  openModal(`${frontHtml}<div class="btn-row" id="srsBtns" style="margin-top:16px">
      <button class="btn btn-danger" data-q="0">Again</button>
      <button class="btn" data-q="3">Hard</button>
      <button class="btn btn-primary" data-q="4">Good</button>
      <button class="btn" data-q="5">Easy</button>
    </div>`, (card) => {
    let flipped = false;
    const flipEl = qs('#flashFlip', card);
    if (flipEl) { flipEl.style.cssText = 'min-height:100px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:12px;padding:20px;cursor:pointer;text-align:center'; on(flipEl, 'click', () => { flipped = !flipped; flipEl.textContent = flipped ? item.back : item.front; }); }
    qsa('[data-q]', card).forEach(b => on(b, 'click', () => {
      const understanding = qs('#srsUnderstanding', card) ? +qs('#srsUnderstanding', card).value : null;
      saveFn(+b.dataset.q, understanding);
      Gamify.add(6, 'Review completed');
      closeModal(); renderStudy(); renderDashboard();
      toast('Review recorded.', 'good');
    }));
  });
}
function simpleMarkdown(text = '') {
  let h = escapeHtml(text);
  h = h.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h2>$1</h2>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  h = h.replace(/^- (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  h = h.replace(/\n/g, '<br>');
  return h;
}
function chapterHtml(subjectId, ch) {
  const overdue = ch.due && ch.due <= todayStr();
  return `<div class="list-item" data-chid="${ch.id}" data-subject="${subjectId}">
    <div class="li-title">${escapeHtml(ch.name)}</div>
    <div class="li-meta">
      <span class="tag">${ch.difficulty}</span><span class="tag">imp: ${ch.importance}</span>
      <span class="tag">understand ${ch.understanding || 0}%</span>
      ${ch.due ? `<span class="tag" style="${overdue ? 'color:var(--bad)' : ''}">due ${ch.due}</span>` : ''}
    </div>
    <button class="btn btn-sm chapter-review-btn">Review</button>
    <button class="icon-btn chapter-del">✕</button>
  </div>`;
}
function renderSubjects(c) {
  const subjects = SubjectsStore.all();
  c.innerHTML = `<form id="subjectForm" class="inline-form"><input type="text" id="subjectName" placeholder="New subject…" required><button class="btn btn-primary" type="submit">Add Subject</button></form>
    <div id="subjectListInner"></div>`;
  qs('#subjectListInner').innerHTML = subjects.map(s => {
    const chapters = s.chapters || [];
    const avg = chapters.length ? Math.round(chapters.reduce((sum, ch) => sum + (ch.understanding || 0), 0) / chapters.length) : 0;
    return `<div class="card widget" style="margin-bottom:12px" data-id="${s.id}">
      <div class="widget-title" style="display:flex;justify-content:space-between">
        <span>${escapeHtml(s.name)} · ${chapters.length} chapters · avg understanding ${avg}%</span>
        <button class="icon-btn subject-del">✕</button>
      </div>
      <div class="chapter-list">${chapters.map(ch => chapterHtml(s.id, ch)).join('')}</div>
      <form class="inline-form chapter-form" data-subject="${s.id}">
        <input type="text" class="chapterName" placeholder="Chapter name…" required>
        <select class="chapterDifficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select>
        <select class="chapterImportance"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
        <select class="chapterInterval"><option value="1">Tomorrow</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
        <button class="btn btn-sm" type="submit">Add Chapter</button>
      </form>
    </div>`;
  }).join('') || '<p class="muted">No subjects yet — add one above.</p>';
}
function renderRevisionQueueView(c) {
  const queue = getRevisionQueue();
  c.innerHTML = queue.length ? queue.map(it => `
    <div class="list-item">
      <div class="li-title">${it.kind === 'chapter' ? `${escapeHtml(it.subjectName)} — ${escapeHtml(it.name)}` : escapeHtml(it.front)}</div>
      <span class="tag">${it.kind}</span>
      <button class="btn btn-sm queue-review-btn" data-kind="${it.kind}" data-subject="${it.subjectId || ''}" data-id="${it.id}">Review</button>
    </div>`).join('') : '<p class="muted">Nothing due — nice work.</p>';
}
function renderNoteList(query) {
  const q = (query || '').toLowerCase();
  let notes = NotesStore.all().filter(n => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)));
  notes = [...notes].sort((a, b) => (b.pinned - a.pinned) || b.createdAt.localeCompare(a.createdAt));
  const el = qs('#noteListInner'); if (!el) return;
  el.innerHTML = notes.length ? notes.map(n => `
    <div class="card widget" style="margin-bottom:10px" data-id="${n.id}">
      <div class="widget-title" style="display:flex;justify-content:space-between">
        <span>${n.pinned ? '📌 ' : ''}${escapeHtml(n.title)}</span>
        <span><button class="icon-btn note-pin">${n.pinned ? 'Unpin' : 'Pin'}</button><button class="icon-btn note-del">✕</button></span>
      </div>
      <div>${simpleMarkdown(n.body)}</div>
      <div class="li-meta">${(n.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    </div>`).join('') : '<p class="muted">No notes found.</p>';
}
function renderNotesView(c) {
  c.innerHTML = `<form id="noteForm" class="inline-form" style="flex-direction:column;align-items:stretch">
      <input type="text" id="noteTitle" placeholder="Note title…">
      <input type="text" id="noteTags" placeholder="Tags, comma separated">
      <textarea id="noteBody" placeholder="Write in Markdown-lite: **bold**, *italic*, # heading, - list item"></textarea>
      <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save Note</button>
    </form>
    <input type="text" id="noteSearch" placeholder="Search notes…" style="margin-bottom:12px;width:100%">
    <div id="noteListInner"></div>`;
  renderNoteList('');
  on(qs('#noteSearch'), 'input', (e) => renderNoteList(e.target.value));
  on(qs('#noteForm'), 'submit', (e) => {
    e.preventDefault();
    NotesStore.add({ id: uid(), title: qs('#noteTitle').value || 'Untitled', tags: qs('#noteTags').value.split(',').map(t => t.trim()).filter(Boolean), body: qs('#noteBody').value, pinned: false, createdAt: new Date().toISOString() });
    qs('#noteForm').reset(); renderNoteList('');
  });
}
function renderFlashcardsView(c) {
  c.innerHTML = `<form id="flashForm" class="inline-form">
      <input type="text" id="flashFront" placeholder="Question / front" required>
      <input type="text" id="flashBack" placeholder="Answer / back" required>
      <button class="btn btn-primary" type="submit">Add Flashcard</button>
    </form>
    <div id="flashListInner"></div>`;
  const cards = FlashStore.all();
  qs('#flashListInner').innerHTML = cards.length ? cards.map(f => `
    <div class="list-item" data-id="${f.id}">
      <div class="li-title">${escapeHtml(f.front)}</div>
      <span class="li-meta">${f.due ? 'due ' + f.due : 'new'}</span>
      <button class="btn btn-sm flash-review-btn">Review</button>
      <button class="icon-btn flash-del">✕</button>
    </div>`).join('') : '<p class="muted">No flashcards yet.</p>';
  on(qs('#flashForm'), 'submit', (e) => {
    e.preventDefault();
    FlashStore.add({ id: uid(), front: qs('#flashFront').value, back: qs('#flashBack').value, repetition: 0, ease: 2.5, interval: 0, due: todayStr(), reviewHistory: [] });
    renderFlashcardsView(c);
  });
}
let currentStudyView = 'subjects';
function renderStudy() {
  qsa('#studyViewSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.studyview === currentStudyView));
  const c = qs('#studyContent');
  if (currentStudyView === 'subjects') renderSubjects(c);
  else if (currentStudyView === 'queue') renderRevisionQueueView(c);
  else if (currentStudyView === 'notes') renderNotesView(c);
  else renderFlashcardsView(c);
}
qsa('#studyViewSeg .seg-btn').forEach(b => on(b, 'click', () => { currentStudyView = b.dataset.studyview; renderStudy(); }));
on(qs('#studyContent'), 'submit', (e) => {
  if (e.target.id === 'subjectForm') {
    e.preventDefault();
    SubjectsStore.add({ id: uid(), name: qs('#subjectName').value, chapters: [] });
    renderStudy();
  } else if (e.target.classList.contains('chapter-form')) {
    e.preventDefault();
    const subjectId = e.target.dataset.subject, s = SubjectsStore.get(subjectId);
    const intervalDays = +qs('.chapterInterval', e.target).value;
    const due = new Date(); due.setDate(due.getDate() + intervalDays);
    s.chapters.push({ id: uid(), name: qs('.chapterName', e.target).value, dateCompleted: todayStr(), difficulty: qs('.chapterDifficulty', e.target).value, importance: qs('.chapterImportance', e.target).value, understanding: 50, notes: '', interval: intervalDays, repetition: 0, ease: 2.5, due: todayStr(due), reviewHistory: [] });
    SubjectsStore.update(subjectId, { chapters: s.chapters });
    renderStudy();
  }
});
delegate(qs('#studyContent'), '.subject-del', 'click', (btn) => { SubjectsStore.remove(btn.closest('[data-id]').dataset.id); renderStudy(); });
delegate(qs('#studyContent'), '.chapter-del', 'click', (btn) => {
  const row = btn.closest('[data-chid]'), s = SubjectsStore.get(row.dataset.subject);
  s.chapters = s.chapters.filter(c => c.id !== row.dataset.chid); SubjectsStore.update(s.id, { chapters: s.chapters }); renderStudy();
});
delegate(qs('#studyContent'), '.chapter-review-btn', 'click', (btn) => { const row = btn.closest('[data-chid]'); openSRSReviewModal('chapter', row.dataset.subject, row.dataset.chid); });
delegate(qs('#studyContent'), '.queue-review-btn', 'click', (btn) => openSRSReviewModal(btn.dataset.kind === 'chapter' ? 'chapter' : 'flashcard', btn.dataset.subject, btn.dataset.id));
delegate(qs('#studyContent'), '.note-pin', 'click', (btn) => { const id = btn.closest('[data-id]').dataset.id, n = NotesStore.get(id); NotesStore.update(id, { pinned: !n.pinned }); renderNoteList(qs('#noteSearch') ? qs('#noteSearch').value : ''); });
delegate(qs('#studyContent'), '.note-del', 'click', (btn) => { NotesStore.remove(btn.closest('[data-id]').dataset.id); renderNoteList(qs('#noteSearch') ? qs('#noteSearch').value : ''); });
delegate(qs('#studyContent'), '.flash-review-btn', 'click', (btn) => openSRSReviewModal('flashcard', null, btn.closest('.list-item').dataset.id));
delegate(qs('#studyContent'), '.flash-del', 'click', (btn) => { FlashStore.remove(btn.closest('.list-item').dataset.id); renderFlashcardsView(qs('#studyContent')); });

/* ============================================================
   10. POMODORO / FOCUS TIMER
   ============================================================ */
const POMO_CIRC = 2 * Math.PI * 90;
const pomoState = { mode: '25-5', focusMin: 25, breakMin: 5, phase: 'focus', remaining: 25 * 60, running: false, timerId: null };

function getPomoData() { return lsGet('charger_pomodoro', { sessions: [] }); }
function savePomoData(d) { lsSet('charger_pomodoro', d); }
function logPomoSession(type, minutes, completed, interruptReason) {
  const d = getPomoData();
  d.sessions.push({ id: uid(), date: todayStr(), type, minutes, completed, interruptReason });
  savePomoData(d);
  if (type === 'focus') TimeLogStore.add({ id: uid(), date: todayStr(), time: new Date().toISOString(), hour: new Date().getHours(), category: 'Deep Work', minutes, source: 'pomodoro' });
  if (qs('#view-pomodoro') && !qs('#view-pomodoro').classList.contains('hidden')) renderPomodoroStats();
}
function pomoUpdateDisplay() {
  const m = Math.floor(pomoState.remaining / 60), s = pomoState.remaining % 60;
  qs('#pomoTimeLabel').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  qs('#pomoPhaseLabel').textContent = pomoState.phase === 'focus' ? 'Focus' : 'Break';
  const total = (pomoState.phase === 'focus' ? pomoState.focusMin : pomoState.breakMin) * 60;
  const frac = 1 - pomoState.remaining / total;
  qs('#pomoRingProgress').style.strokeDashoffset = POMO_CIRC * (1 - frac);
  qs('#pomoRingProgress').setAttribute('stroke', pomoState.phase === 'focus' ? getComputedStyle(document.documentElement).getPropertyValue('--cyan') : 'var(--magenta)');
}
function pomoApplyMode() {
  const modeSel = qs('#pomoMode').value;
  pomoState.mode = modeSel;
  if (modeSel === '25-5') { pomoState.focusMin = 25; pomoState.breakMin = 5; qs('#pomoCustomWrap').classList.add('hidden'); }
  else if (modeSel === '50-10') { pomoState.focusMin = 50; pomoState.breakMin = 10; qs('#pomoCustomWrap').classList.add('hidden'); }
  else { qs('#pomoCustomWrap').classList.remove('hidden'); pomoState.focusMin = +qs('#pomoCustomFocus').value || 25; pomoState.breakMin = +qs('#pomoCustomBreak').value || 5; }
  if (!pomoState.running) { pomoState.phase = 'focus'; pomoState.remaining = pomoState.focusMin * 60; pomoUpdateDisplay(); }
}
function pomoTick() {
  pomoState.remaining--;
  if (pomoState.remaining <= 0) { pomoComplete(); return; }
  pomoUpdateDisplay();
}
function pomoComplete() {
  clearInterval(pomoState.timerId); pomoState.running = false;
  logPomoSession(pomoState.phase, pomoState.phase === 'focus' ? pomoState.focusMin : pomoState.breakMin, true, null);
  playEventSound();
  notify(pomoState.phase === 'focus' ? 'Focus session complete — take a break.' : 'Break over — back to focus.');
  if (pomoState.phase === 'focus') Gamify.add(15, 'Focus session complete');
  pomoState.phase = pomoState.phase === 'focus' ? 'break' : 'focus';
  pomoState.remaining = (pomoState.phase === 'focus' ? pomoState.focusMin : pomoState.breakMin) * 60;
  pomoUpdateDisplay();
  qs('#pomoStart').disabled = false; qs('#pomoPause').disabled = true; qs('#pomoStart').textContent = 'Start';
  renderPomodoroStats();
  if (qs('#pomoAutoStart').checked) pomoStartTimer();
}
function pomoStartTimer() {
  if (pomoState.running) return;
  pomoState.running = true;
  pomoState.timerId = setInterval(pomoTick, 1000);
  qs('#pomoStart').disabled = true; qs('#pomoPause').disabled = false; qs('#pomoStart').textContent = 'Running…';
}
function pomoResetToFresh() {
  clearInterval(pomoState.timerId); pomoState.running = false; pomoState.phase = 'focus';
  pomoState.remaining = pomoState.focusMin * 60; pomoUpdateDisplay();
  qs('#pomoStart').disabled = false; qs('#pomoPause').disabled = true; qs('#pomoStart').textContent = 'Start';
}
function openReasonModal(cb) {
  openModal(`<h3>Session interrupted</h3><p class="muted">What pulled you away? (optional)</p>
    <div class="btn-row" id="reasonChips">${['Phone', 'Noise', 'Tired', 'Switched task', 'Other'].map(r => `<button class="btn reason-chip" data-r="${r}">${r}</button>`).join('')}</div>
    <div class="btn-row" style="margin-top:14px"><button class="btn" id="reasonSkip">Skip</button></div>`, (card) => {
    qsa('.reason-chip', card).forEach(b => on(b, 'click', () => { closeModal(); cb(b.dataset.r); }));
    on(qs('#reasonSkip', card), 'click', () => { closeModal(); cb(null); });
  });
}
on(qs('#pomoMode'), 'change', pomoApplyMode);
on(qs('#pomoCustomFocus'), 'change', pomoApplyMode);
on(qs('#pomoCustomBreak'), 'change', pomoApplyMode);
on(qs('#pomoStart'), 'click', () => pomoStartTimer());
on(qs('#pomoPause'), 'click', () => { clearInterval(pomoState.timerId); pomoState.running = false; qs('#pomoStart').disabled = false; qs('#pomoPause').disabled = true; qs('#pomoStart').textContent = 'Resume'; });
on(qs('#pomoReset'), 'click', () => {
  const total = (pomoState.phase === 'focus' ? pomoState.focusMin : pomoState.breakMin) * 60;
  if (pomoState.running || pomoState.remaining < total) {
    clearInterval(pomoState.timerId); pomoState.running = false;
    openReasonModal((reason) => {
      const elapsedMin = Math.max(1, Math.round((total - pomoState.remaining) / 60));
      logPomoSession(pomoState.phase, elapsedMin, false, reason);
      pomoResetToFresh();
    });
  } else pomoResetToFresh();
});
function renderPomodoroStats() {
  const d = getPomoData(), today = todayStr();
  const todaySessions = d.sessions.filter(s => s.date === today && s.type === 'focus');
  const completed = todaySessions.filter(s => s.completed).length;
  const totalMin = todaySessions.reduce((s, x) => s + x.minutes, 0);
  qs('#pomoStats').innerHTML = `
    <div class="stat-pill"><b>${completed}</b>Sessions today</div>
    <div class="stat-pill"><b>${fmtMin(totalMin)}</b>Focus time today</div>
    <div class="stat-pill"><b>${d.sessions.filter(s => s.type === 'focus' && s.completed).length}</b>All-time sessions</div>`;
  qs('#pomoHistory').innerHTML = [...d.sessions].reverse().slice(0, 12).map(s => `
    <div class="list-item"><div class="li-title">${s.type === 'focus' ? 'Focus' : 'Break'} — ${s.minutes}m</div>
    <span class="tag ${s.completed ? 'tag-low' : 'tag-high'}">${s.completed ? 'completed' : 'interrupted' + (s.interruptReason ? ' (' + s.interruptReason + ')' : '')}</span>
    <span class="li-meta">${s.date}</span></div>`).join('') || '<p class="muted">No sessions yet.</p>';
}
function renderPomodoroView() { pomoApplyMode(); renderPomodoroStats(); }

/* ============================================================
   11. AMBIENT SOUND VIEW
   ============================================================ */
function renderSounds() {
  qs('#soundGrid').innerHTML = SOUND_DEFS.map(s => `<div class="sound-tile ${activeSoundNodes[s.id] ? 'playing' : ''}" data-id="${s.id}"><span class="ic">${s.icon}</span>${s.label}</div>`).join('');
}
delegate(qs('#soundGrid'), '.sound-tile', 'click', (tile) => {
  const id = tile.dataset.id;
  if (activeSoundNodes[id]) { stopSound(id); tile.classList.remove('playing'); }
  else {
    playSound(id); tile.classList.add('playing');
    const mins = +qs('#soundSleepTimer').value;
    if (mins > 0) setTimeout(() => { stopSound(id); tile.classList.remove('playing'); toast('Sleep timer ended — sound stopped.'); }, mins * 60000);
  }
});
on(qs('#soundVolume'), 'input', () => { Object.values(activeSoundNodes).forEach(n => n.gain.gain.value = qs('#soundVolume').value / 100); });

/* ============================================================
   12. ALARMS & REMINDERS
   ============================================================ */
function checkAlarmsAndReminders() {
  const now = new Date(), hh = now.getHours(), mm = now.getMinutes(), dow = now.getDay();
  const fireKey = `${todayStr()}_${hh}:${mm}`;
  AlarmsStore.all().forEach(a => {
    if (!a.enabled || a.hour !== hh || a.minute !== mm) return;
    const days = a.days && a.days.length ? a.days : null;
    if (days && !days.includes(dow)) return;
    if (a._lastFire === fireKey) return;
    AlarmsStore.update(a.id, { _lastFire: fireKey });
    triggerAlarm(a);
  });
  RemindersStore.all().forEach(r => {
    if (!r.enabled || r.hour !== hh || r.minute !== mm) return;
    if (r.type === 'once' && r.date !== todayStr()) return;
    if (r.type === 'weekly' && !(r.days || []).includes(dow)) return;
    if (r._lastFire === fireKey) return;
    RemindersStore.update(r.id, { _lastFire: fireKey });
    triggerReminder(r);
    if (r.type === 'once') RemindersStore.update(r.id, { enabled: false });
  });
}
setInterval(checkAlarmsAndReminders, 15000);
function triggerAlarm(a) { playEventSound(true); notify(`Alarm: ${a.label}`); toast(`⏰ ${a.label}`, 'good'); }
function triggerReminder(r) { playEventSound(); notify(r.text); toast(`🔔 ${r.text}`); }
function renderAlarms() {
  const alarms = AlarmsStore.all();
  qs('#alarmList').innerHTML = alarms.length ? alarms.map(a => `
    <div class="list-item" data-id="${a.id}">
      <div class="li-title">${escapeHtml(a.label)} — ${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}</div>
      <div class="li-meta">${a.days && a.days.length ? a.days.map(d => ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d]).join(' ') : 'Daily'}</div>
      <label class="check-inline"><input type="checkbox" class="alarm-toggle" ${a.enabled ? 'checked' : ''}></label>
      <button class="icon-btn alarm-del">✕</button>
    </div>`).join('') : `<p class="muted">No alarms yet.</p>`;
  const reminders = RemindersStore.all();
  qs('#reminderList').innerHTML = reminders.length ? reminders.map(r => `
    <div class="list-item" data-id="${r.id}">
      <div class="li-title">${escapeHtml(r.text)}</div>
      <div class="li-meta"><span class="tag">${r.type}</span> ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}</div>
      <label class="check-inline"><input type="checkbox" class="reminder-toggle" ${r.enabled ? 'checked' : ''}></label>
      <button class="icon-btn reminder-del">✕</button>
    </div>`).join('') : `<p class="muted">No reminders yet.</p>`;
}
delegate(qs('#alarmList'), '.alarm-toggle', 'change', (cb) => AlarmsStore.update(cb.closest('.list-item').dataset.id, { enabled: cb.checked }));
delegate(qs('#alarmList'), '.alarm-del', 'click', (btn) => { AlarmsStore.remove(btn.closest('.list-item').dataset.id); renderAlarms(); });
delegate(qs('#reminderList'), '.reminder-toggle', 'change', (cb) => RemindersStore.update(cb.closest('.list-item').dataset.id, { enabled: cb.checked }));
delegate(qs('#reminderList'), '.reminder-del', 'click', (btn) => { RemindersStore.remove(btn.closest('.list-item').dataset.id); renderAlarms(); });
function dayChipPicker(containerId) {
  return `<div class="btn-row" id="${containerId}">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d, i) => `<button type="button" class="btn seg-btn day-chip" data-d="${i}">${d}</button>`).join('')}</div>`;
}
on(qs('#addAlarmBtn'), 'click', () => {
  openModal(`<h3>New Alarm</h3>
    <div class="inline-form"><input type="text" id="mAlarmLabel" placeholder="Label (e.g. Wake up)"><input type="time" id="mAlarmTime" value="07:00"></div>
    <p class="muted">Repeat on (leave blank for every day):</p>${dayChipPicker('mAlarmDays')}
    <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="mAlarmSave">Save</button></div>`, (card) => {
    const days = new Set();
    qsa('.day-chip', card).forEach(b => on(b, 'click', () => { b.classList.toggle('active'); days.has(+b.dataset.d) ? days.delete(+b.dataset.d) : days.add(+b.dataset.d); }));
    on(qs('#mAlarmSave', card), 'click', () => {
      const [h, m] = qs('#mAlarmTime', card).value.split(':').map(Number);
      AlarmsStore.add({ id: uid(), label: qs('#mAlarmLabel', card).value || 'Alarm', hour: h, minute: m, days: [...days], enabled: true });
      closeModal(); renderAlarms(); toast('Alarm saved.', 'good');
    });
  });
});
on(qs('#addReminderBtn'), 'click', () => {
  openModal(`<h3>New Reminder</h3>
    <div class="inline-form">
      <input type="text" id="mRemText" placeholder="Reminder text">
      <select id="mRemType"><option value="daily">Daily</option><option value="once">One-time</option><option value="weekly">Weekly</option></select>
      <input type="date" id="mRemDate"><input type="time" id="mRemTime" value="09:00">
    </div>${dayChipPicker('mRemDays')}
    <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="mRemSave">Save</button></div>`, (card) => {
    const days = new Set();
    qsa('.day-chip', card).forEach(b => on(b, 'click', () => { b.classList.toggle('active'); days.has(+b.dataset.d) ? days.delete(+b.dataset.d) : days.add(+b.dataset.d); }));
    on(qs('#mRemSave', card), 'click', () => {
      const [h, m] = qs('#mRemTime', card).value.split(':').map(Number);
      RemindersStore.add({ id: uid(), text: qs('#mRemText', card).value || 'Reminder', type: qs('#mRemType', card).value, date: qs('#mRemDate', card).value || todayStr(), hour: h, minute: m, days: [...days], enabled: true });
      closeModal(); renderAlarms(); toast('Reminder saved.', 'good');
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    });
  });
});

/* ============================================================
   13. GOALS
   ============================================================ */
function goalItemHtml(g) {
  return `<div class="list-item" data-id="${g.id}">
    <div class="li-title">${escapeHtml(g.title)}</div>
    <input type="range" min="0" max="100" value="${g.progress || 0}" class="goal-progress-slider" style="width:120px">
    <span class="tag">${g.progress || 0}%</span>
    <button class="icon-btn goal-del">✕</button>
  </div>`;
}
function renderGoals() {
  const goals = GoalsStore.all();
  const groups = { daily: [], weekly: [], monthly: [], longterm: [] };
  goals.forEach(g => { if (groups[g.term]) groups[g.term].push(g); });
  const label = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', longterm: 'Long-term' };
  qs('#goalList').innerHTML = Object.keys(groups).map(k => `<h3>${label[k]}</h3>${groups[k].length ? groups[k].map(goalItemHtml).join('') : '<p class="muted">No goals yet.</p>'}`).join('');
}
on(qs('#goalForm'), 'submit', (e) => { e.preventDefault(); GoalsStore.add({ id: uid(), title: qs('#goalTitle').value, term: qs('#goalTerm').value, progress: 0, createdAt: todayStr() }); qs('#goalForm').reset(); renderGoals(); });
delegate(qs('#goalList'), '.goal-progress-slider', 'input', (sl) => {
  const id = sl.closest('.list-item').dataset.id;
  GoalsStore.update(id, { progress: +sl.value });
  sl.nextElementSibling.textContent = sl.value + '%';
  if (+sl.value >= 100) { const g = GoalsStore.get(id); if (!g.completedOnce) { Gamify.add(20, 'Goal completed'); GoalsStore.update(id, { completedOnce: true }); } }
});
delegate(qs('#goalList'), '.goal-del', 'click', (btn) => { GoalsStore.remove(btn.closest('.list-item').dataset.id); renderGoals(); });

/* ============================================================
   14. HABITS — streaks, stacking, streak freeze, if-then triggers
   ============================================================ */
function habitStreak(h) {
  let streak = 0, d = new Date(), first = true;
  while (true) {
    const key = todayStr(d);
    const status = h.history && h.history[key];
    if (status === 'done' || status === 'frozen') { streak++; d.setDate(d.getDate() - 1); first = false; }
    else if (first) { d.setDate(d.getDate() - 1); first = false; }
    else break;
  }
  return streak;
}
function renderHabits() {
  const habits = HabitsStore.all(), today = todayStr();
  qs('#habitList').innerHTML = habits.length ? habits.map(h => {
    const doneToday = h.history && h.history[today] === 'done';
    const streak = habitStreak(h);
    const freeze = h.streakFreeze || { used: 0, max: 2 };
    return `<div class="list-item" data-id="${h.id}">
      <input type="checkbox" class="habit-done-cb" ${doneToday ? 'checked' : ''}>
      <div class="li-title">${escapeHtml(h.title)}
        ${h.stackAfter ? `<div class="muted" style="font-size:0.72rem">after: ${escapeHtml(h.stackAfter)}</div>` : ''}
        ${h.trigger ? `<div class="muted" style="font-size:0.72rem">${escapeHtml(h.trigger)}</div>` : ''}
      </div>
      <div class="li-meta"><span class="tag">🔥 ${streak}d</span><span class="tag">freeze ${freeze.used}/${freeze.max}</span></div>
      <button class="btn btn-sm habit-freeze-btn" ${freeze.used >= freeze.max ? 'disabled' : ''}>Freeze today</button>
      <button class="icon-btn habit-del">✕</button>
    </div>`;
  }).join('') : '<p class="muted">No habits yet.</p>';
}
on(qs('#habitForm'), 'submit', (e) => {
  e.preventDefault();
  HabitsStore.add({ id: uid(), title: qs('#habitTitle').value, stackAfter: qs('#habitStackAfter').value, trigger: qs('#habitTrigger').value, history: {}, streakFreeze: { used: 0, max: 2 }, createdAt: todayStr() });
  qs('#habitForm').reset(); renderHabits();
});
delegate(qs('#habitList'), '.habit-done-cb', 'change', (cb) => {
  const id = cb.closest('.list-item').dataset.id, h = HabitsStore.get(id);
  const hist = { ...(h.history || {}) };
  if (cb.checked) { hist[todayStr()] = 'done'; Gamify.add(8, 'Habit completed'); } else delete hist[todayStr()];
  HabitsStore.update(id, { history: hist }); renderHabits();
});
delegate(qs('#habitList'), '.habit-freeze-btn', 'click', (btn) => {
  const id = btn.closest('.list-item').dataset.id, h = HabitsStore.get(id);
  const freeze = h.streakFreeze || { used: 0, max: 2 }; if (freeze.used >= freeze.max) return;
  freeze.used++; const hist = { ...(h.history || {}) }; hist[todayStr()] = 'frozen';
  HabitsStore.update(id, { streakFreeze: freeze, history: hist }); renderHabits(); toast('Streak freeze used — no worries.', 'good');
});
delegate(qs('#habitList'), '.habit-del', 'click', (btn) => { HabitsStore.remove(btn.closest('.list-item').dataset.id); renderHabits(); });

/* ============================================================
   15. TIME AUDIT & ANTI-PROCRASTINATION
   ============================================================ */
function renderLogQuick() {
  const cats = ['Deep Work', 'Shallow Work', 'Break', 'Distraction', 'Rest', 'Sleep'];
  qs('#logQuick').innerHTML = `<div class="btn-row">
      ${cats.map(c => `<button class="btn log-cat-btn" data-c="${c}">${c}</button>`).join('')}
      <input type="text" id="logCustomLabel" placeholder="Custom label…" style="width:140px">
      <button class="btn log-cat-btn" data-c="__custom">Log custom</button>
      <input type="number" id="logMinutes" value="15" min="1" max="240" style="width:70px"> min
    </div>`;
}
delegate(qs('#logQuick'), '.log-cat-btn', 'click', (btn) => {
  let cat = btn.dataset.c;
  if (cat === '__custom') cat = qs('#logCustomLabel').value.trim() || 'Custom';
  const minutes = +qs('#logMinutes').value || 15;
  TimeLogStore.add({ id: uid(), date: todayStr(), time: new Date().toISOString(), hour: new Date().getHours(), category: cat, minutes, source: 'manual' });
  toast(`Logged ${minutes}m — ${cat}`, 'good');
  renderTimeAudit(); renderDashboard();
});
function procrastinationInsights() {
  const insights = [];
  const overdueCompleted = TasksStore.all().filter(t => t.done && t.deadline && t.doneAt && t.doneAt > t.deadline);
  if (overdueCompleted.length >= 2) insights.push(`${overdueCompleted.length} tasks were completed after their original deadline.`);
  const byReason = {};
  getPomoData().sessions.filter(s => !s.completed && s.interruptReason).forEach(s => { byReason[s.interruptReason] = (byReason[s.interruptReason] || 0) + 1; });
  const topReason = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];
  if (topReason) insights.push(`Most common reason for abandoned focus sessions: "${topReason[0]}" (${topReason[1]} times).`);
  const dist = TimeLogStore.all().filter(l => l.category === 'Distraction');
  if (dist.length >= 3) {
    const byHour = {};
    dist.forEach(l => { if (typeof l.hour === 'number') byHour[l.hour] = (byHour[l.hour] || 0) + 1; });
    const peak = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    insights.push(`Distraction has been logged ${dist.length} times${peak ? `, most often around ${peak[0]}:00` : ''}.`);
  }
  if (!insights.length) insights.push('Not enough data yet to detect patterns — keep logging and reviewing.');
  return insights;
}
function renderTimeAudit() {
  renderLogQuick();
  const today = todayStr();
  const todayLogs = TimeLogStore.all().filter(l => l.date === today);
  const byCat = {};
  todayLogs.forEach(l => byCat[l.category] = (byCat[l.category] || 0) + l.minutes);
  const goal = AppSettings.get().dailyFocusGoalMin || 120;
  const deepWork = byCat['Deep Work'] || 0;
  const last7 = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return todayStr(d); });
  const weekByCat = {};
  TimeLogStore.all().filter(l => last7.includes(l.date)).forEach(l => weekByCat[l.category] = (weekByCat[l.category] || 0) + l.minutes);
  qs('#timeAuditContent').innerHTML = `
    <div class="widget-grid">
      <div class="card widget"><div class="widget-title">Today — Deep Work vs Goal</div>
        <p>${fmtMin(deepWork)} / ${fmtMin(goal)} goal</p>
        <div class="xp-bar"><div class="xp-bar-fill" style="width:${clamp(deepWork / goal * 100, 0, 100)}%"></div></div>
      </div>
      <div class="card widget"><div class="widget-title">Today by category</div>
        ${Object.entries(byCat).map(([c, m]) => `<div class="li-meta" style="margin-bottom:4px">${escapeHtml(c)}: <b>${fmtMin(m)}</b></div>`).join('') || '<p class="muted">Nothing logged yet today.</p>'}
      </div>
      <div class="card widget"><div class="widget-title">Weekly Time Leak Report</div>
        ${Object.entries(weekByCat).sort((a, b) => b[1] - a[1]).map(([c, m]) => `<div class="li-meta" style="margin-bottom:4px">${escapeHtml(c)}: <b>${fmtMin(m)}</b></div>`).join('') || '<p class="muted">No data yet this week.</p>'}
      </div>
      <div class="card widget"><div class="widget-title">Procrastination Patterns</div>
        <ul style="margin:0;padding-left:18px">${procrastinationInsights().map(i => `<li style="margin-bottom:6px;font-size:0.85rem">${escapeHtml(i)}</li>`).join('')}</ul>
      </div>
    </div>`;
}

/* ============================================================
   16. DAILY & WEEKLY REVIEW
   ============================================================ */
on(qs('#startEveningReview'), 'click', () => {
  openModal(`<h3>Evening Review</h3>
    <label>What got done today?</label><textarea id="erDone"></textarea>
    <label>What didn't get done?</label><textarea id="erNotDone"></textarea>
    <label>One thing to do differently tomorrow:</label><textarea id="erChange"></textarea>
    <label>Tomorrow's MIT:</label><input type="text" id="erMit" style="width:100%">
    <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="erSave">Save Review</button></div>`, (card) => {
    on(qs('#erSave', card), 'click', () => {
      ReviewsStore.add({ id: uid(), type: 'evening', date: todayStr(), done: qs('#erDone', card).value, notDone: qs('#erNotDone', card).value, change: qs('#erChange', card).value, tomorrowMit: qs('#erMit', card).value });
      const mitVal = qs('#erMit', card).value.trim();
      if (mitVal) {
        const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
        TasksStore.add({ id: uid(), title: mitVal, priority: 'high', deadline: todayStr(tmr), isMIT: true, mitDate: todayStr(tmr), createdAt: todayStr(), done: false, inbox: false, sorted: true });
      }
      Gamify.add(10, 'Evening review');
      closeModal(); renderReviews(); toast('Review saved.', 'good');
    });
  });
});
on(qs('#startWeeklyReview'), 'click', () => {
  const distByDate = {};
  TimeLogStore.all().filter(l => l.category === 'Distraction').forEach(l => distByDate[l.date] = (distByDate[l.date] || 0) + l.minutes);
  const leakSummary = Object.entries(distByDate).map(([d, m]) => `${d}: ${m}m distraction`).join('\n');
  openModal(`<h3>Weekly Review</h3>
    <label>Wins this week:</label><textarea id="wrWins"></textarea>
    <label>Time leaks noticed:</label><textarea id="wrLeaks">${escapeHtml(leakSummary)}</textarea>
    <label>Habit consistency notes:</label><textarea id="wrHabits"></textarea>
    <label>Adjustments for next week:</label><textarea id="wrAdjust"></textarea>
    <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="wrSave">Save Review</button></div>`, (card) => {
    on(qs('#wrSave', card), 'click', () => {
      ReviewsStore.add({ id: uid(), type: 'weekly', date: todayStr(), wins: qs('#wrWins', card).value, leaks: qs('#wrLeaks', card).value, habits: qs('#wrHabits', card).value, adjust: qs('#wrAdjust', card).value });
      Gamify.add(20, 'Weekly review');
      closeModal(); renderReviews(); toast('Weekly review saved.', 'good');
    });
  });
});
function renderReviews() {
  const reviews = [...ReviewsStore.all()].sort((a, b) => b.date.localeCompare(a.date));
  qs('#reviewHistory').innerHTML = reviews.length ? reviews.map(r => `
    <div class="card widget" style="margin-bottom:10px">
      <div class="widget-title">${r.type === 'evening' ? 'Evening' : 'Weekly'} — ${r.date}</div>
      ${r.type === 'evening'
        ? `<p><b>Done:</b> ${escapeHtml(r.done || '—')}</p><p><b>Not done:</b> ${escapeHtml(r.notDone || '—')}</p><p><b>Change:</b> ${escapeHtml(r.change || '—')}</p>`
        : `<p><b>Wins:</b> ${escapeHtml(r.wins || '—')}</p><p><b>Adjust:</b> ${escapeHtml(r.adjust || '—')}</p>`}
    </div>`).join('') : '<p class="muted">No reviews yet.</p>';
}

/* ============================================================
   17. ANALYTICS — canvas charts, no external chart library
   ============================================================ */
function drawBarChart(canvas, labels, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = 180 * 2;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...values);
  const groupW = w / values.length, barW = groupW * 0.55;
  values.forEach((v, i) => {
    const bh = (v / max) * (h - 40), x = i * groupW + (groupW - barW) / 2;
    const grad = ctx.createLinearGradient(0, h - bh - 20, 0, h - 20);
    grad.addColorStop(0, getComputedStyle(document.documentElement).getPropertyValue('--cyan') || '#33f0e0');
    grad.addColorStop(1, 'rgba(255,63,196,0.6)');
    ctx.fillStyle = grad; ctx.fillRect(x, h - bh - 20, barW, bh);
    ctx.fillStyle = '#9aa3c0'; ctx.font = '20px Inter'; ctx.textAlign = 'center';
    ctx.fillText(labels[i], x + barW / 2, h - 4);
  });
}
function drawLineChart(canvas, labels, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = (canvas.clientHeight || 90) * 2;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...values);
  const stepX = w / ((values.length - 1) || 1);
  ctx.beginPath();
  values.forEach((v, i) => { const x = i * stepX, y = h - 20 - (v / max) * (h - 40); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cyan') || '#33f0e0';
  ctx.lineWidth = 4; ctx.stroke();
  values.forEach((v, i) => { const x = i * stepX, y = h - 20 - (v / max) * (h - 40); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = '#ff3fc4'; ctx.fill(); });
  ctx.fillStyle = '#9aa3c0'; ctx.font = '20px Inter'; ctx.textAlign = 'center';
  labels.forEach((l, i) => { if (l) ctx.fillText(l, i * stepX, h - 2); });
}
function drawDualBarChart(canvas, labels, valuesA, valuesB) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = 180 * 2;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...valuesA, ...valuesB);
  const groupW = w / labels.length, barW = groupW * 0.3;
  labels.forEach((l, i) => {
    const bhA = (valuesA[i] / max) * (h - 40), bhB = (valuesB[i] / max) * (h - 40);
    const gx = i * groupW + groupW * 0.15;
    ctx.fillStyle = '#ff3fc4'; ctx.fillRect(gx, h - bhA - 20, barW, bhA);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cyan') || '#33f0e0';
    ctx.fillRect(gx + barW + 4, h - bhB - 20, barW, bhB);
    ctx.fillStyle = '#9aa3c0'; ctx.font = '20px Inter'; ctx.textAlign = 'center';
    ctx.fillText(l, gx + barW, h - 2);
  });
}
function last7Dates() { return [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d; }); }
function focusScoreForDate(dateStr) {
  const pomo = getPomoData().sessions.filter(s => s.date === dateStr && s.type === 'focus');
  const completed = pomo.filter(s => s.completed).length;
  const logs = TimeLogStore.all().filter(l => l.date === dateStr);
  const total = logs.reduce((s, l) => s + l.minutes, 0);
  const deep = logs.filter(l => l.category === 'Deep Work').reduce((s, l) => s + l.minutes, 0);
  const deepRatio = total ? deep / total : 0;
  const tasks = TasksStore.all().filter(t => t.deadline === dateStr || (t.done && t.doneAt === dateStr));
  const taskRate = tasks.length ? tasks.filter(t => t.done).length / tasks.length : 0;
  return clamp(Math.round(completed * 10 + deepRatio * 50 + taskRate * 40), 0, 100);
}
function renderAnalytics() {
  const days = last7Dates();
  const labels = days.map(d => d.toLocaleDateString(undefined, { weekday: 'short' }));
  const dateStrs = days.map(d => todayStr(d));
  const studyMins = dateStrs.map(ds => TimeLogStore.all().filter(l => l.date === ds && l.category === 'Deep Work').reduce((s, l) => s + l.minutes, 0));
  const tasksCompleted = dateStrs.map(ds => TasksStore.all().filter(t => t.done && t.doneAt === ds).length);
  const focusScores = dateStrs.map(focusScoreForDate);
  const distractionMins = dateStrs.map(ds => TimeLogStore.all().filter(l => l.date === ds && l.category === 'Distraction').reduce((s, l) => s + l.minutes, 0));
  const habits = HabitsStore.all();
  const habitSuccess = dateStrs.map(ds => habits.length ? Math.round(habits.filter(h => h.history && (h.history[ds] === 'done' || h.history[ds] === 'frozen')).length / habits.length * 100) : 0);
  qs('#analyticsContent').innerHTML = `
    <div class="widget-grid">
      <div class="card widget"><div class="widget-title">Deep Work minutes (7d)</div><canvas id="chartStudy" style="width:100%;height:180px"></canvas></div>
      <div class="card widget"><div class="widget-title">Tasks completed (7d)</div><canvas id="chartTasks" style="width:100%;height:180px"></canvas></div>
      <div class="card widget"><div class="widget-title">Focus Score (7d)</div><canvas id="chartFocus" style="width:100%;height:180px"></canvas></div>
      <div class="card widget"><div class="widget-title">Habit success rate % (7d)</div><canvas id="chartHabit" style="width:100%;height:180px"></canvas></div>
      <div class="card widget"><div class="widget-title">Distraction (magenta) vs Deep Work (cyan), min (7d)</div><canvas id="chartWaste" style="width:100%;height:180px"></canvas></div>
    </div>`;
  drawBarChart(qs('#chartStudy'), labels, studyMins);
  drawBarChart(qs('#chartTasks'), labels, tasksCompleted);
  drawLineChart(qs('#chartFocus'), labels, focusScores);
  drawBarChart(qs('#chartHabit'), labels, habitSuccess);
  drawDualBarChart(qs('#chartWaste'), labels, distractionMins, studyMins);
}

/* ============================================================
   18. CALENDAR
   ============================================================ */
let calCursor = new Date();
function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  qs('#calLabel').textContent = calCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const events = EventsStore.all();
  const typeColor = { event: 'var(--cyan)', deadline: 'var(--bad)', revision: 'var(--warn)', exam: 'var(--magenta)' };
  let cellsHtml = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => `<div class="muted" style="text-align:center;font-size:0.72rem">${d}</div>`).join('');
  for (let i = 0; i < startWeekday; i++) cellsHtml += `<div class="cal-cell other-month"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = todayStr(new Date(y, m, d));
    const dayEvents = events.filter(e => e.date === ds);
    const isToday = ds === todayStr();
    cellsHtml += `<div class="cal-cell ${isToday ? 'today' : ''}" data-date="${ds}"><div class="cal-num">${d}</div>${dayEvents.slice(0, 3).map(e => `<span class="cal-dot" style="background:${typeColor[e.type] || 'var(--cyan)'}"></span>`).join('')}</div>`;
  }
  qs('#calGrid').innerHTML = cellsHtml;
  qs('#calDayList').innerHTML = '';
}
delegate(qs('#calGrid'), '.cal-cell', 'click', (cell) => {
  const ds = cell.dataset.date; if (!ds) return;
  const dayEvents = EventsStore.all().filter(e => e.date === ds);
  qs('#calDayList').innerHTML = `<h3>${ds}</h3>` + (dayEvents.length ? dayEvents.map(e => `<div class="list-item" data-id="${e.id}"><div class="li-title">${escapeHtml(e.title)}</div><span class="tag">${e.type}</span><button class="icon-btn cal-ev-del">✕</button></div>`).join('') : '<p class="muted">No events.</p>');
});
delegate(qs('#calDayList'), '.cal-ev-del', 'click', (btn) => { EventsStore.remove(btn.closest('.list-item').dataset.id); renderCalendar(); });
on(qs('#calPrev'), 'click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); });
on(qs('#calNext'), 'click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); });
on(qs('#eventForm'), 'submit', (e) => { e.preventDefault(); EventsStore.add({ id: uid(), title: qs('#eventTitle').value, date: qs('#eventDate').value, type: qs('#eventType').value }); qs('#eventForm').reset(); renderCalendar(); });

/* ============================================================
   19. BOOK TRACKER
   ============================================================ */
function renderBooks() {
  const books = BooksStore.all();
  qs('#bookList').innerHTML = books.length ? books.map(b => {
    const pct = b.totalPages ? clamp(Math.round((b.currentPage || 0) / b.totalPages * 100), 0, 100) : 0;
    return `<div class="list-item" data-id="${b.id}" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;gap:10px;align-items:center">
        <div class="li-title">${escapeHtml(b.title)} ${b.author ? `<span class="muted">— ${escapeHtml(b.author)}</span>` : ''}</div>
        <button class="icon-btn book-del">✕</button>
      </div>
      <div class="xp-bar" style="margin:6px 0"><div class="xp-bar-fill" style="width:${pct}%"></div></div>
      <div class="btn-row">
        <input type="number" class="book-page-input" value="${b.currentPage || 0}" min="0" max="${b.totalPages || 9999}" style="width:80px"> / ${b.totalPages || '?'} pages (${pct}%)
      </div>
      <textarea class="book-notes" placeholder="Notes / highlights…" style="width:100%;margin-top:6px">${escapeHtml(b.notes || '')}</textarea>
    </div>`;
  }).join('') : '<p class="muted">No books yet.</p>';
}
on(qs('#bookForm'), 'submit', (e) => { e.preventDefault(); BooksStore.add({ id: uid(), title: qs('#bookTitle').value, author: qs('#bookAuthor').value, totalPages: +qs('#bookTotalPages').value || 0, currentPage: 0, notes: '' }); qs('#bookForm').reset(); renderBooks(); });
delegate(qs('#bookList'), '.book-page-input', 'change', (inp) => {
  const id = inp.closest('.list-item').dataset.id, b = BooksStore.get(id);
  BooksStore.update(id, { currentPage: +inp.value });
  if (b.totalPages && +inp.value >= b.totalPages && !b.finishedOnce) { Gamify.add(25, 'Finished a book'); BooksStore.update(id, { finishedOnce: true }); }
  renderBooks();
});
delegate(qs('#bookList'), '.book-notes', 'change', (ta) => BooksStore.update(ta.closest('.list-item').dataset.id, { notes: ta.value }));
delegate(qs('#bookList'), '.book-del', 'click', (btn) => { BooksStore.remove(btn.closest('.list-item').dataset.id); renderBooks(); });

/* ============================================================
   20. LIFE — routines, health, energy, journal
   ============================================================ */
let currentLifeView = 'routines';
function renderRoutines(c) {
  const routines = RoutinesStore.all();
  c.innerHTML = `<form id="routineForm" class="inline-form"><input type="text" id="routineName" placeholder="Routine name (e.g. Morning)" required><button class="btn btn-primary" type="submit">Add Routine</button></form><div id="routineListInner"></div>`;
  qs('#routineListInner').innerHTML = routines.map(r => `
    <div class="card widget" style="margin-bottom:10px" data-id="${r.id}">
      <div class="widget-title" style="display:flex;justify-content:space-between"><span>${escapeHtml(r.name)}</span><button class="icon-btn routine-del">✕</button></div>
      ${(r.items || []).map((it, i) => `<label class="check-inline" style="display:flex;margin-bottom:6px"><input type="checkbox" class="routine-item-cb" data-i="${i}" ${it.doneDate === todayStr() ? 'checked' : ''}> ${escapeHtml(it.text)}</label>`).join('')}
      <div class="inline-form"><input type="text" class="routine-item-input" placeholder="Add checklist item…"><button class="btn btn-sm routine-item-add" type="button">Add</button></div>
    </div>`).join('') || '<p class="muted">No routines yet.</p>';
  on(qs('#routineForm'), 'submit', (e) => { e.preventDefault(); RoutinesStore.add({ id: uid(), name: qs('#routineName').value, items: [] }); renderLife(); });
}
delegate(qs('#lifeContent'), '.routine-del', 'click', (btn) => { RoutinesStore.remove(btn.closest('[data-id]').dataset.id); renderLife(); });
delegate(qs('#lifeContent'), '.routine-item-add', 'click', (btn) => {
  const card = btn.closest('[data-id]'), id = card.dataset.id, r = RoutinesStore.get(id);
  const input = qs('.routine-item-input', card); if (!input.value.trim()) return;
  r.items = r.items || []; r.items.push({ text: input.value.trim() }); RoutinesStore.update(id, { items: r.items }); renderLife();
});
delegate(qs('#lifeContent'), '.routine-item-cb', 'change', (cb) => {
  const card = cb.closest('[data-id]'), id = card.dataset.id, r = RoutinesStore.get(id);
  r.items[+cb.dataset.i].doneDate = cb.checked ? todayStr() : null;
  RoutinesStore.update(id, { items: r.items });
  if (cb.checked) Gamify.add(3, 'Routine step');
});
function renderHealth(c) {
  const today = todayStr();
  const entries = HealthLogStore.all();
  let todayEntry = entries.find(e => e.date === today);
  if (!todayEntry) { todayEntry = { id: uid(), date: today, waterCups: 0, sleepHours: null, exerciseMin: 0, food: '' }; HealthLogStore.add(todayEntry); }
  c.innerHTML = `<div class="card widget">
      <div class="widget-title">Today</div>
      <label>Water (cups): <input type="number" id="hWater" value="${todayEntry.waterCups || 0}" min="0" style="width:70px"></label><br><br>
      <label>Sleep (hours): <input type="number" id="hSleep" value="${todayEntry.sleepHours ?? ''}" min="0" max="24" step="0.5" style="width:70px"></label><br><br>
      <label>Exercise (min): <input type="number" id="hExercise" value="${todayEntry.exerciseMin || 0}" min="0" style="width:70px"></label><br><br>
      <label>Food notes: <input type="text" id="hFood" value="${escapeHtml(todayEntry.food || '')}" style="width:60%"></label>
    </div>
    <h3>History (last 14 days)</h3>
    <div>${entries.slice(-14).reverse().map(e => `<div class="li-meta" style="margin-bottom:4px">${e.date}: 💧${e.waterCups || 0} cups · 😴${e.sleepHours ?? '—'}h · 🏃${e.exerciseMin || 0}min</div>`).join('')}</div>`;
  ['hWater', 'hSleep', 'hExercise', 'hFood'].forEach(id => on(qs('#' + id), 'change', () => {
    HealthLogStore.update(todayEntry.id, { waterCups: +qs('#hWater').value, sleepHours: qs('#hSleep').value ? +qs('#hSleep').value : null, exerciseMin: +qs('#hExercise').value, food: qs('#hFood').value });
  }));
}
function renderEnergy(c) {
  const today = todayStr(), slots = ['Morning', 'Midday', 'Afternoon', 'Evening'], entries = EnergyLogStore.all().filter(e => e.date === today);
  c.innerHTML = `<div class="card widget"><div class="widget-title">Today's Energy</div><div class="btn-row">${slots.map(s => {
    const existing = entries.find(e => e.slot === s);
    return `<div><div class="muted" style="font-size:0.75rem;margin-bottom:4px">${s}</div><div class="btn-row">${['low', 'medium', 'high'].map(l => `<button class="btn btn-sm energy-btn ${existing && existing.level === l ? 'btn-primary' : ''}" data-slot="${s}" data-level="${l}">${l}</button>`).join('')}</div></div>`;
  }).join('')}</div></div>`;
}
delegate(qs('#lifeContent'), '.energy-btn', 'click', (btn) => {
  const slot = btn.dataset.slot, level = btn.dataset.level, today = todayStr();
  const existing = EnergyLogStore.all().find(e => e.date === today && e.slot === slot);
  if (existing) EnergyLogStore.update(existing.id, { level }); else EnergyLogStore.add({ id: uid(), date: today, slot, level });
  renderLife();
});
function renderJournal(c) {
  c.innerHTML = `<form id="journalForm" class="inline-form" style="flex-direction:column;align-items:stretch">
      <select id="journalMood"><option value="😊">😊 Good</option><option value="😐">😐 Neutral</option><option value="😔">😔 Low</option><option value="😤">😤 Stressed</option><option value="🥰">🥰 Grateful</option></select>
      <textarea id="journalText" placeholder="Today's reflection…"></textarea>
      <input type="text" id="journalGratitude" placeholder="One thing I'm grateful for…">
      <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save Entry</button>
    </form><div id="journalListInner"></div>`;
  const entries = [...JournalStore.all()].sort((a, b) => b.date.localeCompare(a.date));
  qs('#journalListInner').innerHTML = entries.map(e => `<div class="card widget" style="margin-bottom:10px"><div class="widget-title">${e.date} ${e.mood || ''}</div><p>${escapeHtml(e.text || '')}</p>${e.gratitude ? `<p class="muted">🙏 ${escapeHtml(e.gratitude)}</p>` : ''}</div>`).join('') || '<p class="muted">No entries yet.</p>';
  on(qs('#journalForm'), 'submit', (e) => {
    e.preventDefault();
    JournalStore.add({ id: uid(), date: todayStr(), mood: qs('#journalMood').value, text: qs('#journalText').value, gratitude: qs('#journalGratitude').value });
    Gamify.add(5, 'Journal entry'); renderLife();
  });
}
function renderLife() {
  qsa('#lifeViewSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.lifeview === currentLifeView));
  const c = qs('#lifeContent');
  if (currentLifeView === 'routines') renderRoutines(c);
  else if (currentLifeView === 'health') renderHealth(c);
  else if (currentLifeView === 'energy') renderEnergy(c);
  else renderJournal(c);
}
qsa('#lifeViewSeg .seg-btn').forEach(b => on(b, 'click', () => { currentLifeView = b.dataset.lifeview; renderLife(); }));

/* ============================================================
   21. DIGITAL DISCIPLINE — self-tracking, framed honestly
   ============================================================ */
function renderDiscipline() {
  const list = [...DistractionsStore.all()].sort((a, b) => b.at.localeCompare(a.at));
  qs('#distractionList').innerHTML = list.length ? list.map(d => `<div class="list-item" data-id="${d.id}"><div class="li-title">${escapeHtml(d.text)}</div><span class="li-meta">${d.at.slice(0, 16).replace('T', ' ')}</span><button class="icon-btn dist-del">✕</button></div>`).join('') : '<p class="muted">Nothing logged.</p>';
}
delegate(qs('#distractionList'), '.dist-del', 'click', (btn) => { DistractionsStore.remove(btn.closest('.list-item').dataset.id); renderDiscipline(); });
on(qs('#distractionForm'), 'submit', (e) => { e.preventDefault(); DistractionsStore.add({ id: uid(), text: qs('#distractionText').value, at: new Date().toISOString() }); qs('#distractionForm').reset(); renderDiscipline(); });
on(qs('#focusModeBtn'), 'click', () => {
  document.body.classList.add('focus-mode');
  navigateTo('pomodoro');
  toast('Focus Mode on — distractions hidden here. This only affects this tab.', 'good');
  if (!qs('#exitFocusBtn')) {
    const exitBtn = document.createElement('button');
    exitBtn.className = 'btn'; exitBtn.textContent = 'Exit Focus Mode'; exitBtn.id = 'exitFocusBtn';
    exitBtn.style.cssText = 'position:fixed;top:14px;right:14px;z-index:500';
    exitBtn.onclick = () => { document.body.classList.remove('focus-mode'); exitBtn.remove(); };
    document.body.appendChild(exitBtn);
  }
});

/* ============================================================
   22. SETTINGS — appearance, sound, notifications, backup
   ============================================================ */
function renderSettings() {
  const s = AppSettings.get();
  qs('#settingsContent').innerHTML = `
    <div class="widget-grid">
      <div class="card widget"><div class="widget-title">Appearance</div>
        <label>Accent theme:
          <select id="setAccent">${Object.keys(THEME_ACCENTS).map(t => `<option value="${t}" ${s.accent === t ? 'selected' : ''} ${!Gamify.data().unlockedThemes.includes(t) ? 'disabled' : ''}>${t}${!Gamify.data().unlockedThemes.includes(t) ? ' (locked)' : ''}</option>`).join('')}</select>
        </label>
      </div>
      <div class="card widget"><div class="widget-title">Sound</div>
        <label class="check-inline"><input type="checkbox" id="setMasterMute" ${s.soundMasterMute ? 'checked' : ''}> Mute all sound</label><br><br>
        <label class="check-inline"><input type="checkbox" id="setUiClick" ${s.uiClickSound ? 'checked' : ''}> UI click sounds</label><br><br>
        <label class="check-inline"><input type="checkbox" id="setNotifSound" ${s.notifSound ? 'checked' : ''}> Sound on alarms/reminders/completions</label>
      </div>
      <div class="card widget"><div class="widget-title">Notifications</div>
        <button class="btn" id="setReqNotif">Enable system notifications</button>
        <p class="muted" style="margin-top:8px">Status: ${('Notification' in window) ? Notification.permission : 'unsupported in this browser'}</p>
      </div>
      <div class="card widget"><div class="widget-title">Focus goal &amp; review day</div>
        <label>Daily focus-time goal (minutes): <input type="number" id="setFocusGoal" value="${s.dailyFocusGoalMin || 120}" style="width:80px"></label><br><br>
        <label>Weekly review day: <select id="setReviewDay">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<option value="${i}" ${s.weeklyReviewDay === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      </div>
      <div class="card widget"><div class="widget-title">Data — schema v${SCHEMA_VERSION}</div>
        <div class="btn-row">
          <button class="btn btn-primary" id="setExport">Export backup (JSON)</button>
          <button class="btn" id="setImport">Import backup</button>
          <button class="btn btn-danger" id="setReset">Reset all data</button>
        </div>
        <input type="file" id="setImportFile" accept="application/json" class="hidden">
      </div>
      <div class="card widget"><div class="widget-title">Dashboard layout</div>
        <p class="muted">Drag widgets on the Dashboard to reorder. Toggle visibility here:</p>
        ${getDashboardLayout().map(l => { const w = DASHBOARD_WIDGETS.find(x => x.id === l.id); return `<label class="check-inline" style="display:block;margin-bottom:6px"><input type="checkbox" class="layout-vis-cb" data-id="${l.id}" ${l.visible ? 'checked' : ''}> ${w ? w.title : l.id}</label>`; }).join('')}
      </div>
    </div>`;
}
delegate(qs('#settingsContent'), '.layout-vis-cb', 'change', (cb) => { const layout = getDashboardLayout(); const item = layout.find(l => l.id === cb.dataset.id); item.visible = cb.checked; AppSettings.set({ dashboardLayout: layout }); });
on(qs('#settingsContent'), 'change', (e) => {
  if (e.target.id === 'setAccent') applyAccent(e.target.value);
  if (e.target.id === 'setMasterMute') AppSettings.set({ soundMasterMute: e.target.checked });
  if (e.target.id === 'setUiClick') AppSettings.set({ uiClickSound: e.target.checked });
  if (e.target.id === 'setNotifSound') AppSettings.set({ notifSound: e.target.checked });
  if (e.target.id === 'setFocusGoal') AppSettings.set({ dailyFocusGoalMin: +e.target.value });
  if (e.target.id === 'setReviewDay') AppSettings.set({ weeklyReviewDay: +e.target.value });
  if (e.target.id === 'setImportFile') importBackup(e.target.files[0]);
});
on(qs('#settingsContent'), 'click', (e) => {
  if (e.target.id === 'setReqNotif') Notification.requestPermission().then(() => renderSettings());
  if (e.target.id === 'setExport') exportBackup();
  if (e.target.id === 'setImport') qs('#setImportFile').click();
  if (e.target.id === 'setReset') confirmReset();
});
function exportBackup() {
  const payload = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), localStorage: {}, indexedDB: Cache };
  Object.keys(localStorage).filter(k => k.startsWith('charger_')).forEach(k => payload.localStorage[k] = lsGet(k, null));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `charger-backup-${todayStr()}.json`; a.click();
  AppSettings.set({ lastBackupPrompt: Date.now() });
  toast('Backup exported.', 'good');
}
function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      Object.entries(payload.localStorage || {}).forEach(([k, v]) => lsSet(k, v));
      Object.entries(payload.indexedDB || {}).forEach(([store, items]) => { Cache[store] = items || []; (items || []).forEach(it => idbPut(store, it)); });
      toast('Backup imported — reloading…', 'good');
      setTimeout(() => location.reload(), 900);
    } catch (e) { toast('Could not read that backup file.', 'bad'); }
  };
  reader.readAsText(file);
}
function confirmReset() {
  openModal(`<h3>Reset all data?</h3><p>This deletes everything Charger has stored on this device. This cannot be undone unless you have a backup.</p>
    <div class="btn-row"><button class="btn btn-danger" id="confirmResetBtn">Yes, delete everything</button><button class="btn" id="cancelResetBtn">Cancel</button></div>`, (card) => {
    on(qs('#confirmResetBtn', card), 'click', () => {
      Object.keys(localStorage).filter(k => k.startsWith('charger_')).forEach(k => localStorage.removeItem(k));
      IDB_STORES.forEach(s => { Cache[s] = []; if (idbInstance) { try { idbInstance.transaction(s, 'readwrite').objectStore(s).clear(); } catch (e) {} } });
      closeModal(); toast('All data reset.', 'good'); setTimeout(() => location.reload(), 700);
    });
    on(qs('#cancelResetBtn', card), 'click', closeModal);
  });
}

/* ============================================================
   23. COMMAND PALETTE / GLOBAL QUICK CAPTURE (Ctrl/Cmd+K)
   ============================================================ */
function openPalette() { qs('#paletteOverlay').classList.remove('hidden'); qs('#paletteInput').value = ''; qs('#paletteInput').focus(); renderPaletteResults(''); }
function closePalette() { qs('#paletteOverlay').classList.add('hidden'); }
on(qs('#paletteOverlay'), 'click', (e) => { if (e.target.id === 'paletteOverlay') closePalette(); });
on(document, 'keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape') { closePalette(); closeModal(); }
});
on(qs('#quickCaptureBtn'), 'click', openPalette);
function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const navItems = VIEWS.map(v => ({ label: 'Go to ' + v.charAt(0).toUpperCase() + v.slice(1), action: () => { navigateTo(v); closePalette(); } }));
  const actionItems = [
    { label: 'Start Pomodoro', action: () => { navigateTo('pomodoro'); pomoStartTimer(); closePalette(); } },
    { label: 'Log: Deep Work (15m)', action: () => { TimeLogStore.add({ id: uid(), date: todayStr(), time: new Date().toISOString(), hour: new Date().getHours(), category: 'Deep Work', minutes: 15, source: 'palette' }); toast('Logged.', 'good'); closePalette(); } },
    { label: 'Log: Distraction (15m)', action: () => { TimeLogStore.add({ id: uid(), date: todayStr(), time: new Date().toISOString(), hour: new Date().getHours(), category: 'Distraction', minutes: 15, source: 'palette' }); toast('Logged.', 'good'); closePalette(); } },
    { label: 'New habit…', action: () => { navigateTo('habits'); closePalette(); } }
  ];
  let items = [...actionItems, ...navItems];
  if (q) items = items.filter(i => i.label.toLowerCase().includes(q));
  const results = qs('#paletteResults');
  if (q && !items.length) results.innerHTML = `<div class="palette-item">Press Enter to capture "<b>${escapeHtml(query)}</b>" as a task <span class="palette-hint">→ Inbox</span></div>`;
  else results.innerHTML = items.slice(0, 8).map((it, i) => `<div class="palette-item" data-idx="${i}">${it.label}</div>`).join('');
  results._items = items;
}
on(qs('#paletteInput'), 'input', (e) => renderPaletteResults(e.target.value));
on(qs('#paletteInput'), 'keydown', (e) => {
  if (e.key === 'Enter') {
    const val = qs('#paletteInput').value.trim();
    const items = qs('#paletteResults')._items || [];
    if (items.length) items[0].action();
    else if (val) { TasksStore.add({ id: uid(), title: val, priority: 'medium', inbox: true, sorted: false, createdAt: todayStr(), done: false }); toast('Captured to Inbox.', 'good'); closePalette(); }
  }
});
delegate(qs('#paletteResults'), '.palette-item', 'click', (item) => { const items = qs('#paletteResults')._items || []; const it = items[+item.dataset.idx]; if (it) it.action(); });
function setupVoiceCapture() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return; // graceful degradation on unsupported browsers
  const card = qs('.palette-card'); card.style.position = 'relative';
  const micBtn = document.createElement('button');
  micBtn.textContent = '🎤'; micBtn.className = 'icon-btn'; micBtn.style.cssText = 'position:absolute;right:10px;top:8px';
  card.appendChild(micBtn);
  const rec = new SpeechRec(); rec.continuous = false; rec.interimResults = false;
  on(micBtn, 'click', () => { try { rec.start(); micBtn.textContent = '🔴'; } catch (e) {} });
  rec.onresult = (e) => { qs('#paletteInput').value = e.results[0][0].transcript; renderPaletteResults(qs('#paletteInput').value); micBtn.textContent = '🎤'; };
  rec.onerror = () => micBtn.textContent = '🎤';
  rec.onend = () => micBtn.textContent = '🎤';
}

/* ============================================================
   24. GUIDED FIRST-RUN ONBOARDING ("Synchronize" flow)
   ============================================================ */
const ONBOARD_STEPS = ['welcome', 'theme', 'pomodoro', 'reviewday', 'habits'];
let onboardIdx = 0;
const onboardData = { accent: 'cyan', pomoFocus: 25, pomoBreak: 5, reviewDay: 0, habits: [] };
function renderOnboardStep() {
  const step = ONBOARD_STEPS[onboardIdx];
  const card = qs('#onboardCard');
  let html = '';
  if (step === 'welcome') html = `<h2>Welcome to Charger</h2><p class="muted">A quick, skippable setup — pick a few defaults and you're in.</p><div class="btn-row" style="margin-top:16px"><button class="btn" id="obSkip">Skip setup</button><button class="btn btn-primary" id="obNext">Let's go</button></div>`;
  else if (step === 'theme') html = `<h2>Pick an accent</h2><div class="btn-row">${['cyan', 'magenta'].map(t => `<button class="btn ob-theme-btn" data-t="${t}" style="border-color:${THEME_ACCENTS[t]}">${t}</button>`).join('')}</div><div class="btn-row" style="margin-top:16px"><button class="btn" id="obSkip">Skip</button><button class="btn btn-primary" id="obNext">Next</button></div>`;
  else if (step === 'pomodoro') html = `<h2>Default focus length</h2><div class="inline-form"><input type="number" id="obFocus" value="25" min="5" max="120"> min focus / <input type="number" id="obBreak" value="5" min="1" max="30"> min break</div><div class="btn-row" style="margin-top:16px"><button class="btn" id="obSkip">Skip</button><button class="btn btn-primary" id="obNext">Next</button></div>`;
  else if (step === 'reviewday') html = `<h2>Weekly review day</h2><select id="obReviewDay">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select><div class="btn-row" style="margin-top:16px"><button class="btn" id="obSkip">Skip</button><button class="btn btn-primary" id="obNext">Next</button></div>`;
  else html = `<h2>1–3 starter habits</h2><input type="text" id="obHabit1" placeholder="Habit 1 (e.g. Read 20 min)"><input type="text" id="obHabit2" placeholder="Habit 2 (optional)" style="margin-top:8px"><input type="text" id="obHabit3" placeholder="Habit 3 (optional)" style="margin-top:8px"><div class="btn-row" style="margin-top:16px"><button class="btn btn-primary" id="obFinish">Finish setup</button></div>`;
  card.innerHTML = html;
  on(qs('#obSkip', card), 'click', finishOnboarding);
  const nextBtn = qs('#obNext', card);
  if (nextBtn) on(nextBtn, 'click', () => {
    if (step === 'pomodoro') { onboardData.pomoFocus = +qs('#obFocus', card).value; onboardData.pomoBreak = +qs('#obBreak', card).value; }
    if (step === 'reviewday') onboardData.reviewDay = +qs('#obReviewDay', card).value;
    onboardIdx++; renderOnboardStep();
  });
  qsa('.ob-theme-btn', card).forEach(b => on(b, 'click', () => { onboardData.accent = b.dataset.t; qsa('.ob-theme-btn', card).forEach(x => x.style.outline = ''); b.style.outline = '2px solid #fff'; }));
  const finishBtn = qs('#obFinish', card);
  if (finishBtn) on(finishBtn, 'click', () => {
    ['obHabit1', 'obHabit2', 'obHabit3'].forEach(id => { const v = qs('#' + id, card).value.trim(); if (v) onboardData.habits.push(v); });
    finishOnboarding();
  });
}
function finishOnboarding() {
  applyAccent(onboardData.accent);
  AppSettings.set({ defaultPomoFocus: onboardData.pomoFocus, defaultPomoBreak: onboardData.pomoBreak, weeklyReviewDay: onboardData.reviewDay, onboarded: true });
  onboardData.habits.forEach(h => HabitsStore.add({ id: uid(), title: h, history: {}, streakFreeze: { used: 0, max: 2 }, createdAt: todayStr() }));
  qs('#onboarding').classList.add('hidden');
  qs('#app').classList.remove('hidden');
  navigateTo('dashboard');
}

/* ============================================================
   25. BACKUP REMINDER BANNER
   ============================================================ */
function checkBackupReminder() {
  const days = (Date.now() - (AppSettings.get().lastBackupPrompt || 0)) / 86400000;
  if (days >= 7) qs('#backupBanner').classList.remove('hidden');
}
on(qs('#backupBannerExport'), 'click', () => { exportBackup(); qs('#backupBanner').classList.add('hidden'); });
on(qs('#backupBannerDismiss'), 'click', () => { AppSettings.set({ lastBackupPrompt: Date.now() }); qs('#backupBanner').classList.add('hidden'); });

/* ============================================================
   26. BIO-SYNC PARTICLE FIELD (decorative, capped, respects reduced motion/data)
   ============================================================ */
function initBioCanvas() {
  const canvas = qs('#bioCanvas');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduceData = window.matchMedia('(prefers-reduced-data: reduce)').matches;
  if (reduceMotion || reduceData) return;
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize(); on(window, 'resize', resize);
  const particles = [];
  for (let i = 0; i < 34; i++) particles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, r: Math.random() * 2 + 0.6, vx: (Math.random() - 0.5) * 0.15, vy: (Math.random() - 0.5) * 0.15, hue: Math.random() > 0.5 ? '#33f0e0' : '#ff3fc4' });
  (function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.globalAlpha = 0.35; ctx.fillStyle = p.hue; ctx.fill(); ctx.globalAlpha = 1;
    });
    requestAnimationFrame(frame);
  })();
}

/* ============================================================
   27. XP MINI (sidebar)
   ============================================================ */
function renderXPMini() {
  const p = Gamify.progress();
  qs('#xpLevelLabel').textContent = 'Lv ' + Gamify.level();
  qs('#xpNumLabel').textContent = p.total + ' XP';
  qs('#xpBarFill').style.width = p.pct + '%';
}

/* ============================================================
   28. LIVE CLOCK
   ============================================================ */
function tickClock() {
  const el = qs('#liveClock'); if (!el) return;
  el.textContent = new Date().toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' });
}
setInterval(tickClock, 1000);

/* ============================================================
   29. SERVICE WORKER REGISTRATION
   ============================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

/* ============================================================
   30. BOOTSTRAP
   ============================================================ */
async function initApp() {
  try {
    idbInstance = await idbOpen();
    for (const s of IDB_STORES) Cache[s] = await idbAll(s);
  } catch (e) {
    console.warn('IndexedDB unavailable — notes/flashcards/time-logs/journal will only persist for this session.', e);
  }
  applyAccent(AppSettings.get().accent || 'cyan');
  renderXPMini();
  initBioCanvas();
  setupVoiceCapture();
  checkBackupReminder();
  tickClock();

  const startView = (location.hash || '#dashboard').slice(1);
  navigateTo(VIEWS.includes(startView) ? startView : 'dashboard');

  if (AppSettings.get().onboarded) {
    qs('#app').classList.remove('hidden');
  } else {
    qs('#onboarding').classList.remove('hidden');
    renderOnboardStep();
  }
}
initApp();
