// CSV / table parsing with column auto-detection. Pure, no DOM.
import { guessUnit, guessTimeUnitFromValues, DEFAULT_UNIT } from './units.js';

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DECIMAL_COMMA_RE = /^[-+]?\d+,\d+([eE][-+]?\d+)?$/;

export function parseNumber(s) {
  if (typeof s === 'number') return s;
  if (s === undefined || s === null) return NaN;
  let v = String(s).trim().replace(/^"|"$/g, '').trim();
  if (v === '') return NaN;
  if (DECIMAL_COMMA_RE.test(v)) v = v.replace(',', '.');
  return NUM_RE.test(v) ? Number(v) : NaN;
}

function splitLine(line, delim) {
  if (delim === 'ws') return line.trim().split(/\s+/);
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function detectDelimiter(lines) {
  const sample = lines.slice(0, 8);
  let best = null;
  let bestScore = 0;
  for (const d of [',', ';', '\t']) {
    const counts = sample.map((l) => splitLine(l, d).length - 1);
    const min = Math.min(...counts);
    if (min > 0) {
      const score = min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0);
      if (score > bestScore) { bestScore = score; best = d; }
    }
  }
  if (best) return best;
  return sample.some((l) => /\s/.test(l.trim())) ? 'ws' : ',';
}

// Parse CSV text into { delimiter, headers, rows, hasHeader, comments }.
// Comment lines start with '#' or '//'. A BOM is stripped.
export function parseCSV(text) {
  const clean = String(text).replace(/^﻿/, '');
  const all = clean.split(/\r\n|\n|\r/);
  const comments = [];
  const lines = [];
  for (const raw of all) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#') || l.startsWith('//')) { comments.push(l.replace(/^(#|\/\/)\s?/, '')); continue; }
    lines.push(raw);
  }
  if (!lines.length) throw new Error('The file contains no data rows.');
  const delimiter = detectDelimiter(lines);
  const table = lines.map((l) => splitLine(l, delimiter));
  const first = table[0];
  const hasHeader = first.some((c) => c !== '' && Number.isNaN(parseNumber(c)));
  const headers = hasHeader ? first.map((h, i) => h || `col${i + 1}`) : first.map((_, i) => `col${i + 1}`);
  const rows = hasHeader ? table.slice(1) : table;
  return { delimiter, headers, rows, hasHeader, comments };
}

// ---- column detection ---------------------------------------------------

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const RULES = {
  time: [/^(flight_)?time/, /^t$/, /^t_/, /timestamp/, /^millis/, /^elapsed/, /^seconds?$/, /^ms$/, /^sec$/],
  altitude: [/^altitude/, /^alt($|_)/, /baro_?alt/, /^height/, /^agl/, /_agl/, /altitude/, /(^|_)alt($|_)/, /height/],
  velocity: [/^velocity/, /^vel($|_)/, /vert(ical)?_?(speed|vel)/, /^v_?speed/, /^speed/, /velocity/, /(^|_)vel($|_)/],
  acceleration: [/^accel/, /^acc($|_)/, /^az($|_)/, /^a_?z($|_)/, /acceleration/, /g_?force/, /accel/],
  lat: [/^lat($|_)/, /latitude/],
  lon: [/^lon($|_)/, /^lng($|_)/, /longitude/, /^long($|_)/],
  event: [/^events?$/, /^state/, /^phase/, /flight_?state/, /^status/, /^stage/, /event/],
};

function scoreHeader(kind, header) {
  const n = norm(header);
  const rules = RULES[kind];
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].test(n)) {
      let s = 100 - i * 5;
      if (kind === 'altitude' && /gps/.test(n)) s -= 40; // prefer barometric altitude
      if (kind === 'altitude' && /(vel|speed|acc)/.test(n)) s -= 80;
      if (kind === 'velocity' && /acc/.test(n)) s -= 80;
      return s;
    }
  }
  return 0;
}

function colStats(rows, idx) {
  let numeric = 0;
  let nonEmpty = 0;
  for (const r of rows) {
    const c = r[idx];
    if (c === undefined || c === '') continue;
    nonEmpty++;
    if (!Number.isNaN(parseNumber(c))) numeric++;
  }
  return { numeric, nonEmpty, numericRatio: nonEmpty ? numeric / nonEmpty : 0 };
}

// Returns { mapping: {time, altitude, velocity, acceleration, lat, lon, event} (column index or -1),
//           units: {time, length, velocity, accel}, guessed: {which units came from header hints} }
export function detectColumns(headers, rows) {
  const mapping = { time: -1, altitude: -1, velocity: -1, acceleration: -1, lat: -1, lon: -1, event: -1 };
  const used = new Set();
  const order = ['time', 'lat', 'lon', 'event', 'velocity', 'acceleration', 'altitude'];
  for (const kind of order) {
    let best = -1;
    let bestScore = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const st = colStats(rows, i);
      if (kind === 'event') {
        if (st.nonEmpty === 0 || st.numericRatio > 0.5) return;
      } else if (st.numericRatio < 0.5) return;
      const s = scoreHeader(kind, h);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best >= 0) { mapping[kind] = best; used.add(best); }
  }
  // Headerless / unnamed fallback: first two numeric columns are time, altitude.
  if (mapping.time < 0 && mapping.altitude < 0) {
    const numericCols = headers.map((_, i) => i).filter((i) => colStats(rows, i).numericRatio >= 0.5);
    if (numericCols.length >= 2) {
      mapping.time = numericCols[0];
      mapping.altitude = numericCols[1];
    }
  } else if (mapping.time < 0 || mapping.altitude < 0) {
    const free = headers.map((_, i) => i).filter((i) => !used.has(i) && colStats(rows, i).numericRatio >= 0.5);
    if (mapping.time < 0 && free.length) { mapping.time = free[0]; free.shift(); }
    if (mapping.altitude < 0 && free.length) mapping.altitude = free[0];
  }

  const units = { ...DEFAULT_UNIT };
  const guessed = {};
  const hint = (kind, ukey, col) => {
    if (col < 0) return;
    const g = guessUnit(kind, headers[col]);
    if (g) { units[ukey] = g; guessed[ukey] = true; }
  };
  hint('length', 'length', mapping.altitude);
  hint('time', 'time', mapping.time);
  hint('velocity', 'velocity', mapping.velocity);
  hint('accel', 'accel', mapping.acceleration);
  if (!guessed.time && mapping.time >= 0) {
    units.time = guessTimeUnitFromValues(rows.map((r) => parseNumber(r[mapping.time])));
  }
  return { mapping, units, guessed };
}

// Pull numeric series out of a parsed table according to a mapping.
// Values stay in their source units; conversion happens in buildDataFlight.
export function extractSeries(parsed, mapping) {
  const { rows } = parsed;
  const col = (k) => (mapping[k] !== undefined && mapping[k] >= 0 ? mapping[k] : -1);
  const get = (k) => {
    const c = col(k);
    return c < 0 ? null : rows.map((r) => parseNumber(r[c]));
  };
  const time = get('time');
  const altitude = get('altitude');
  if (!time) throw new Error('No time column selected.');
  if (!altitude) throw new Error('No altitude column selected.');
  const out = {
    time,
    altitude,
    velocity: get('velocity'),
    acceleration: get('acceleration'),
    lat: get('lat'),
    lon: get('lon'),
    labels: [],
    skipped: 0,
  };
  for (let i = 0; i < time.length; i++) {
    if (!Number.isFinite(time[i]) || !Number.isFinite(altitude[i])) out.skipped++;
  }
  const ec = col('event');
  if (ec >= 0) {
    let prev = '';
    rows.forEach((r, i) => {
      const v = (r[ec] || '').trim();
      if (v && v !== prev) out.labels.push({ index: i, t: time[i], label: v });
      if (v) prev = v;
    });
  }
  return out;
}

// Accept JSON in several shapes and turn it into either
//  { type:'records', records:[...] }  (a .starrocket.json export)  or
//  { type:'table', headers, rows }    (generic samples).
export function parseJSONInput(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  if (data && data.format === 'starrocket-flights' && Array.isArray(data.flights)) return { type: 'records', records: data.flights };
  if (data && data.format === 'starrocket-flight') return { type: 'records', records: [data] };
  let samples = null;
  if (Array.isArray(data)) samples = data;
  else if (data && Array.isArray(data.samples)) samples = data.samples;
  else if (data && Array.isArray(data.data)) samples = data.data;
  if (samples && samples.length && typeof samples[0] === 'object' && !Array.isArray(samples[0])) {
    const headers = [...new Set(samples.flatMap((s) => Object.keys(s)))];
    const rows = samples.map((s) => headers.map((h) => (s[h] === undefined || s[h] === null ? '' : String(s[h]))));
    return { type: 'table', headers, rows };
  }
  if (samples && samples.length && Array.isArray(samples[0])) {
    const headerRow = samples[0].every((c) => typeof c === 'string');
    const headers = headerRow ? samples[0].map(String) : samples[0].map((_, i) => `col${i + 1}`);
    const body = headerRow ? samples.slice(1) : samples;
    return { type: 'table', headers, rows: body.map((r) => r.map((c) => (c === null ? '' : String(c)))) };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).filter((k) => Array.isArray(data[k]) && data[k].length && typeof data[k][0] !== 'object');
    if (keys.length >= 2) {
      const n = Math.max(...keys.map((k) => data[k].length));
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(keys.map((k) => (data[k][i] === undefined || data[k][i] === null ? '' : String(data[k][i]))));
      return { type: 'table', headers: keys, rows };
    }
  }
  throw new Error('Unrecognised JSON layout. Expected a .starrocket.json export, an array of sample objects, or an object of column arrays.');
}
