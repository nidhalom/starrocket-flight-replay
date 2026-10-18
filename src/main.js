// App wiring: simulation panel, data import, saved flights, comparison, HUD, graphs, playback.
import { flightFromSim, buildDataFlight, sampleAt } from './flight.js';
import { DEFAULT_PARAMS, PARAM_SPECS } from './physics.js';
import { parseCSV, detectColumns, extractSeries, parseJSONInput } from './csv.js';
import { FlightStore, flightFromRecord, exportJSON, safeFileName } from './storage.js';
import { EVENT_LABELS } from './events.js';
import { CHARTS, drawChart, chartTimeAt, renderSheet } from './graph.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);

let storage = null;
try { storage = window.localStorage; storage.getItem('x'); } catch { storage = null; }
const store = new FlightStore(storage);

const state = {
  primary: null,
  compare: null,
  offsetB: 0,
  tMin: 0,
  tMax: 1,
  time: 0,
  playing: true,
  speed: 4,
  dirty: true,
  data: null, // { fileName, headers, rows, mapping }
};

// ---------------------------------------------------------------- scene
let view = null;
try {
  view = createScene($('scene'));
} catch (e) {
  document.body.insertAdjacentHTML('beforeend', '<div class="msg err" style="position:fixed;top:70px;left:50%;transform:translateX(-50%)">3D view unavailable (WebGL or Three.js failed to load). Graphs and data import still work.</div>');
  console.error(e);
}

// ---------------------------------------------------------------- helpers
function setMsg(id, text, cls = '') {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg ' + cls;
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fmtT = (s) => s.toFixed(1);

// ---------------------------------------------------------------- flights in view
function recomputeDomain() {
  const a = state.primary, b = state.compare;
  const la = a.events.find((e) => e.name === 'liftoff');
  const lb = b && b.events.find((e) => e.name === 'liftoff');
  state.offsetB = la && lb ? la.t - lb.t : 0;
  state.tMin = Math.min(0, b ? state.offsetB : 0);
  state.tMax = Math.max(a.duration, b ? b.duration + state.offsetB : 0);
  const scrub = $('scrub');
  scrub.min = state.tMin.toFixed(2);
  scrub.max = state.tMax.toFixed(2);
  scrub.step = ((state.tMax - state.tMin) / 1000).toFixed(3);
  state.time = Math.min(Math.max(state.time, state.tMin), state.tMax);
}

function refreshView() {
  const a = state.primary;
  recomputeDomain();
  if (view) view.setFlights(a, state.compare);
  $('legA').textContent = 'A: ' + a.name;
  $('legB').textContent = state.compare ? 'B: ' + state.compare.name : '';
  $('swB').hidden = !state.compare;
  const sim = a.kind === 'sim';
  document.querySelectorAll('[data-sim]').forEach((e) => { e.hidden = !sim; });
  document.querySelectorAll('[data-data]').forEach((e) => { e.hidden = sim; });
  document.querySelectorAll('[data-b]').forEach((e) => { e.hidden = !state.compare; });
  $('t-rangeLabel').textContent = a.meta.hasGps ? 'E / N' : a.meta.driftEstimated ? 'DRIFT E / N' : 'POS X / Y';
  $('subtitle').textContent = sim
    ? 'Simulation mode — built-in physics model, not recorded data'
    : `Data mode — ${a.name}${a.meta.hasGps ? '' : ' (no GPS: drift is an estimate)'}`;
  const ev = $('events');
  ev.textContent = '';
  for (const e of a.events) {
    const b = document.createElement('button');
    b.textContent = `${e.name === 'custom' ? e.label : EVENT_LABELS[e.name]} ${e.t.toFixed(1)}s`;
    b.addEventListener('click', () => { state.time = e.t; setPlaying(false); });
    ev.appendChild(b);
  }
  state.dirty = true;
}

function setPrimary(flight) {
  state.primary = flight;
  state.time = 0;
  refreshView();
}

// ---------------------------------------------------------------- playback UI
const playBtn = $('playBtn'), scrub = $('scrub');
function setPlaying(v) { state.playing = v; playBtn.textContent = v ? '⏸ Pause' : '▶ Play'; }
playBtn.addEventListener('click', () => {
  if (!state.playing && state.time >= state.tMax - 1e-6) state.time = state.tMin;
  setPlaying(!state.playing);
});
$('resetBtn').addEventListener('click', () => { state.time = state.tMin; setPlaying(true); });
scrub.addEventListener('input', () => { state.time = parseFloat(scrub.value); setPlaying(false); state.dirty = true; });
[0.25, 0.5, 1, 2, 4, 8, 16].forEach((s) => {
  const b = document.createElement('button');
  b.textContent = s + 'x';
  if (s === state.speed) b.classList.add('active');
  b.addEventListener('click', () => {
    state.speed = s;
    $('speedGroup').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
  $('speedGroup').appendChild(b);
});
const VIEWS = ['follow', 'overview', 'cinematic'];
$('viewBtn').addEventListener('click', () => {
  if (!view) return;
  const m = VIEWS[(VIEWS.indexOf(view.getViewMode()) + 1) % VIEWS.length];
  view.setViewMode(m);
  $('viewBtn').textContent = 'View: ' + m[0].toUpperCase() + m.slice(1);
});
$('orbitBtn').addEventListener('click', () => {
  const on = !$('orbitBtn').classList.contains('active');
  $('orbitBtn').classList.toggle('active', on);
  if (view) view.setAutoOrbit(on);
});
$('hiVisBtn').addEventListener('click', () => {
  const on = !$('hiVisBtn').classList.contains('active');
  $('hiVisBtn').classList.toggle('active', on);
  if (view) view.setHighVis(on);
});
$('shotBtn').addEventListener('click', () => {
  if (!view) return;
  view.update(state.time, state.offsetB);
  view.render();
  view.canvas.toBlob((blob) => blob && download(`starrocket-${safeFileName(state.primary.name)}-3d.png`, blob), 'image/png');
});
$('drawerBtn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('graphBtn').addEventListener('click', () => document.body.classList.toggle('graphs-open'));
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.code === 'ArrowRight') { state.time = Math.min(state.tMax, state.time + 0.5); setPlaying(false); }
  else if (e.code === 'ArrowLeft') { state.time = Math.max(state.tMin, state.time - 0.5); setPlaying(false); }
});

// ---------------------------------------------------------------- charts
const charts = CHARTS.map((spec, i) => ({ spec, canvas: $('chart' + i), w: 0, h: 0 }));
function sizeCharts() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of charts) {
    const r = c.canvas.getBoundingClientRect();
    if (!r.width) continue;
    c.w = Math.round(r.width); c.h = Math.round(r.height);
    c.canvas.width = c.w * dpr; c.canvas.height = c.h * dpr;
    c.ctx = c.canvas.getContext('2d');
    c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  state.dirty = true;
}
charts.forEach((c) => {
  const seek = (e) => {
    const r = c.canvas.getBoundingClientRect();
    state.time = chartTimeAt(e.clientX - r.left, c.w, state.tMin, state.tMax);
    setPlaying(false);
    state.dirty = true;
  };
  let down = false;
  c.canvas.addEventListener('pointerdown', (e) => { down = true; c.canvas.setPointerCapture(e.pointerId); seek(e); });
  c.canvas.addEventListener('pointermove', (e) => { if (down) seek(e); });
  c.canvas.addEventListener('pointerup', () => { down = false; });
});
function drawCharts() {
  if (!state.primary) return;
  for (const c of charts) {
    if (!c.ctx) continue;
    drawChart(c.ctx, c.w, c.h, c.spec, {
      a: state.primary, b: state.compare, offsetB: state.offsetB, tMin: state.tMin, tMax: state.tMax, tNow: state.time,
    });
  }
}
$('graphPng').addEventListener('click', () => {
  const cv = renderSheet(document, { a: state.primary, b: state.compare, offsetB: state.offsetB, tMin: state.tMin, tMax: state.tMax });
  cv.toBlob((blob) => blob && download(`starrocket-${safeFileName(state.primary.name)}-graphs.png`, blob), 'image/png');
});

// ---------------------------------------------------------------- HUD
const T = {
  phase: $('t-phase'), time: $('t-time'), alt: $('t-alt'), v: $('t-vspeed'), acc: $('t-acc'), pos: $('t-pos'),
  pitch: $('t-pitch'), roll: $('t-roll'), yaw: $('t-yaw'), path: $('t-path'), balt: $('t-balt'), dalt: $('t-dalt'),
};
function updateHUD() {
  const a = state.primary;
  const f = sampleAt(a, state.time);
  T.phase.textContent = f.phase;
  T.time.textContent = (state.time < 0 ? 'T' : 'T+') + state.time.toFixed(2) + ' s';
  T.alt.textContent = f.alt.toFixed(0) + ' m';
  T.v.textContent = (f.vAlt >= 0 ? '+' : '') + f.vAlt.toFixed(1) + ' m/s';
  T.acc.textContent = f.acc.toFixed(1) + ' m/s²';
  T.pos.textContent = f.x.toFixed(0) + ' / ' + f.y.toFixed(0) + ' m';
  if (a.kind === 'sim') {
    T.pitch.textContent = f.pitch.toFixed(1) + '°';
    T.roll.textContent = (((f.roll % 360) + 360) % 360).toFixed(1) + '°';
    T.yaw.textContent = f.yaw.toFixed(1) + '°';
  } else {
    const sp = Math.hypot(f.vx, f.vy, f.vAlt);
    T.path.textContent = f.vAlt > 3 && sp > 3 ? (Math.acos(Math.max(-1, Math.min(1, f.vAlt / sp))) * 180 / Math.PI).toFixed(1) + '° from up' : '—';
  }
  if (state.compare) {
    const tb = state.time - state.offsetB;
    const fb = sampleAt(state.compare, tb);
    T.balt.textContent = fb.alt.toFixed(0) + ' m';
    T.dalt.textContent = (f.alt - fb.alt >= 0 ? '+' : '') + (f.alt - fb.alt).toFixed(0) + ' m';
  }
  $('timeReadout').textContent = `${fmtT(state.time)} / ${fmtT(state.tMax)} s`;
}

// ---------------------------------------------------------------- loop
let lastNow = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const delta = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  if (!state.primary) return;
  if (state.playing) {
    state.time += delta * state.speed;
    if (state.time >= state.tMax) { state.time = state.tMax; setPlaying(false); }
    scrub.value = state.time;
    state.dirty = true;
  } else if (parseFloat(scrub.value) !== state.time) scrub.value = state.time;
  if (view) { view.update(state.time, state.offsetB, delta); view.render(); }
  updateHUD();
  if (state.dirty) { drawCharts(); state.dirty = state.playing; }
}
window.addEventListener('resize', () => { if (view) view.resize(); sizeCharts(); });

// ---------------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== 'pane-' + t.dataset.tab; });
  if (t.dataset.tab === 'flights') renderSaved();
}));

// ---------------------------------------------------------------- simulation tab
const SIM_KEY = 'starrocket.simparams';
function loadSimParams() {
  try { return { ...DEFAULT_PARAMS, ...JSON.parse(storage.getItem(SIM_KEY) || '{}') }; } catch { return { ...DEFAULT_PARAMS }; }
}
const simBox = $('simParams');
for (const s of PARAM_SPECS) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${s.label} <small>${s.unit}</small></span>`;
  const i = document.createElement('input');
  i.type = 'number'; i.id = 'p-' + s.key; i.min = s.min; i.max = s.max; i.step = s.step;
  l.appendChild(i);
  simBox.appendChild(l);
}
function writeSimInputs(p) { for (const s of PARAM_SPECS) $('p-' + s.key).value = p[s.key]; }
function readSimInputs() { const p = {}; for (const s of PARAM_SPECS) p[s.key] = $('p-' + s.key).value; return p; }
function runSim() {
  const f = flightFromSim(readSimInputs(), 'Simulation');
  try { storage.setItem(SIM_KEY, JSON.stringify(f.meta.params)); } catch { /* storage optional */ }
  writeSimInputs(f.meta.params);
  setPrimary(f);
  const s = f.stats;
  setMsg('simMsg', (f.meta.warnings.length ? f.meta.warnings.join('\n') + '\n' : '') +
    `Apogee ${s.apogee.toFixed(0)} m at T+${s.apogeeT.toFixed(1)} s, max speed ${s.maxVel.toFixed(0)} m/s, landing ${s.landingRange.toFixed(0)} m downrange.`, f.meta.warnings.length ? 'err' : 'ok');
  setPlaying(true);
}
$('runSim').addEventListener('click', runSim);
$('resetSim').addEventListener('click', () => { writeSimInputs(DEFAULT_PARAMS); runSim(); });

// ---------------------------------------------------------------- data tab
const MAP_KINDS = [['time', 'Time'], ['altitude', 'Altitude'], ['velocity', 'Velocity'], ['acceleration', 'Accel'], ['lat', 'Latitude'], ['lon', 'Longitude'], ['event', 'Events']];
const mapGrid = $('mapGrid');
for (const [k, label] of MAP_KINDS) {
  const l = document.createElement('label');
  l.append(label + ' ');
  const s = document.createElement('select');
  s.id = 'map-' + k;
  s.addEventListener('change', rebuildData);
  l.appendChild(s);
  mapGrid.appendChild(l);
}
['uTime', 'uLen', 'uVel', 'uAcc', 'zeroAlt', 'trim', 'dWind', 'dWindDir', 'dataName'].forEach((id) => $(id).addEventListener('change', rebuildData));
$('smooth').addEventListener('input', () => { $('smoothOut').textContent = $('smooth').value; });
$('smooth').addEventListener('change', rebuildData);

function loadTable(fileName, headers, rows, comments = []) {
  const det = detectColumns(headers, rows);
  state.data = { fileName, headers, rows, comments };
  for (const [k] of MAP_KINDS) {
    const s = $('map-' + k);
    s.textContent = '';
    const none = document.createElement('option');
    none.value = '-1'; none.textContent = '(none)';
    s.appendChild(none);
    headers.forEach((h, i) => { const o = document.createElement('option'); o.value = i; o.textContent = h; s.appendChild(o); });
    s.value = String(det.mapping[k]);
  }
  $('uTime').value = det.units.time; $('uLen').value = det.units.length;
  $('uVel').value = det.units.velocity; $('uAcc').value = det.units.accel;
  $('dataName').value = fileName.replace(/\.[^.]+$/, '');
  $('mapping').hidden = false;
  rebuildData();
}

function rebuildData() {
  const d = state.data;
  if (!d) return;
  try {
    const mapping = {};
    for (const [k] of MAP_KINDS) mapping[k] = parseInt($('map-' + k).value, 10);
    const series = extractSeries({ rows: d.rows }, mapping);
    const hasGps = !!(series.lat && series.lon);
    $('windBox').hidden = hasGps;
    const flight = buildDataFlight(series, {
      units: { time: $('uTime').value, length: $('uLen').value, velocity: $('uVel').value, accel: $('uAcc').value },
      smoothing: parseInt($('smooth').value, 10),
      zeroAltitude: $('zeroAlt').checked,
      trim: $('trim').checked,
      wind: { speed: parseFloat($('dWind').value) || 0, dir: parseFloat($('dWindDir').value) || 0 },
      name: $('dataName').value || d.fileName,
    });
    setPrimary(flight);
    setPlaying(true);
    const s = flight.stats, m = flight.meta;
    const found = flight.events.map((e) => (e.name === 'custom' ? e.label : e.name) + ' ' + e.t.toFixed(1) + 's').join(', ');
    setMsg('dataMsg', [
      `${m.sampleCount} samples at ~${m.rateHz} Hz. Apogee ${s.apogee.toFixed(0)} m (T+${s.apogeeT.toFixed(1)} s).`,
      `Events: ${found || 'none detected'}`,
      m.derivedVelocity ? 'Velocity derived from altitude.' : 'Velocity taken from file.',
      m.hasGps ? 'Downrange path from GPS.' : 'No GPS: downrange path is a wind-drift estimate.',
      ...m.warnings,
    ].join('\n'), m.warnings.length ? '' : 'ok');
  } catch (e) {
    setMsg('dataMsg', e.message, 'err');
  }
}

async function handleFile(file) {
  try {
    const text = await file.text();
    const looksJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text);
    if (looksJson) {
      const j = parseJSONInput(text);
      if (j.type === 'records') {
        const flights = j.records.map(flightFromRecord);
        setPrimary(flights[0]);
        let saved = 0;
        for (const f of flights) { try { store.save(f, f.name); saved++; } catch { /* storage full */ } }
        setMsg('flightMsg', `Imported ${flights.length} flight(s)${saved ? ' and added to saved flights' : ''}.`, 'ok');
        renderSaved();
        activateTab('flights');
        setPlaying(true);
        return;
      }
      activateTab('data');
      loadTable(file.name, j.headers, j.rows);
      return;
    }
    const parsed = parseCSV(text);
    activateTab('data');
    loadTable(file.name, parsed.headers, parsed.rows, parsed.comments);
  } catch (e) {
    setMsg('dataMsg', e.message, 'err');
    setMsg('flightMsg', e.message, 'err');
  }
}
function activateTab(name) { document.querySelector(`.tab[data-tab="${name}"]`).click(); }
$('dataFile').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
$('importFile').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
const dz = $('dropZone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== dz && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

async function loadSample(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const parsed = parseCSV(text);
    loadTable(path.split('/').pop(), parsed.headers, parsed.rows, parsed.comments);
  } catch (e) {
    setMsg('dataMsg', 'Could not load the sample (' + e.message + '). Serve the folder over http (npm start) instead of opening index.html from disk.', 'err');
  }
}
$('loadSample1').addEventListener('click', () => loadSample('samples/synthetic-baro-only.csv'));
$('loadSample2').addEventListener('click', () => loadSample('samples/synthetic-gps-events.csv'));

// ---------------------------------------------------------------- flights tab
function renderSaved() {
  const ul = $('savedList');
  ul.textContent = '';
  const list = store.list();
  if (!list.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="nm"><small>' + (storage ? 'Nothing saved yet.' : 'Browser storage unavailable; use file export.') + '</small></span>';
    ul.appendChild(li);
    return;
  }
  for (const item of list) {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name;
    const small = document.createElement('small');
    small.textContent = `${item.kind === 'sim' ? 'simulation' : 'data'}${item.apogee != null ? ', apogee ' + item.apogee.toFixed(0) + ' m' : ''}`;
    nm.appendChild(small);
    li.appendChild(nm);
    const mk = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.addEventListener('click', fn); li.appendChild(b); };
    mk('Load', 'Show as flight A', () => { const f = store.get(item.id); if (f) { setPrimary(f); setPlaying(true); } });
    mk('B', 'Compare against this flight (B)', () => { const f = store.get(item.id); if (f) { state.compare = f; refreshView(); setMsg('flightMsg', `Comparing A with B: ${f.name}`, 'ok'); } });
    mk('x', 'Delete', () => { store.remove(item.id); renderSaved(); });
    ul.appendChild(li);
  }
}
$('saveBtn').addEventListener('click', () => {
  try {
    const name = $('saveName').value.trim() || state.primary.name;
    store.save(state.primary, name);
    setMsg('flightMsg', `Saved "${name}".`, 'ok');
    renderSaved();
  } catch (e) { setMsg('flightMsg', e.message, 'err'); }
});
$('pinBtn').addEventListener('click', () => { state.compare = state.primary; refreshView(); setMsg('flightMsg', `Pinned "${state.primary.name}" as B. Load another flight as A to compare.`, 'ok'); });
$('clearB').addEventListener('click', () => { state.compare = null; refreshView(); setMsg('flightMsg', 'Comparison cleared.'); });
$('exportBtn').addEventListener('click', () => {
  download(`${safeFileName(state.primary.name)}.starrocket.json`, new Blob([exportJSON([state.primary])], { type: 'application/json' }));
});
$('exportAllBtn').addEventListener('click', () => {
  const flights = store.list().map((i) => store.get(i.id)).filter(Boolean);
  if (!flights.length) { setMsg('flightMsg', 'No saved flights to export.', 'err'); return; }
  download('starrocket-flights.starrocket.json', new Blob([exportJSON(flights.length === 1 ? [flights[0]] : flights)], { type: 'application/json' }));
});

// ---------------------------------------------------------------- start
writeSimInputs(loadSimParams());
runSim();
sizeCharts();
requestAnimationFrame(frame);

// Preview scenarios for automated screenshots/checks: index.html?scenario=sim|data|compare&at=0.6
// (at = fraction of the time from liftoff to landing, default 0.5). Not used in normal operation.
window.starrocket = { state, loadTable, setPlaying, runSim, activateTab, rebuildData };
const qs = new URLSearchParams(location.search);
if (qs.has('scenario')) {
  (async () => {
    const sc = qs.get('scenario');
    if (sc === 'data' || sc === 'compare') {
      if (sc === 'compare') {
        await loadSample('samples/synthetic-gps-events.csv');
        state.compare = state.primary;
      }
      await loadSample(sc === 'compare' ? 'samples/synthetic-baro-only.csv' : 'samples/synthetic-gps-events.csv');
      activateTab(sc === 'compare' ? 'flights' : 'data');
    }
    if (sc === 'compare') refreshView();
    setPlaying(false);
    state.time = state.tMin + (state.tMax - state.tMin) * parseFloat(qs.get('at') || '0.5');
    if (qs.get('view')) { const n = ['follow', 'overview', 'cinematic'].indexOf(qs.get('view')); for (let i = 0; i < n; i++) $('viewBtn').click(); }
    if (qs.get('hivis')) $('hiVisBtn').click();
    if (qs.get('narrow')) document.body.classList.add('graphs-open');
    state.dirty = true;
  })();
}
