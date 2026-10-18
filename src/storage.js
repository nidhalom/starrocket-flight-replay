// Saving / loading flights: localStorage list + .starrocket.json import/export. No DOM access
// at import time; the storage object is injected so it can be tested with a fake.
import { makeFlight } from './flight.js';

export const FORMAT = 'starrocket-flight';
export const FORMAT_MULTI = 'starrocket-flights';
export const VERSION = 1;
const KEY = 'starrocket.flights.v1';

const r = (n, d = 4) => +Number(n).toFixed(d);

export function flightToRecord(flight) {
  const f = flight.frames;
  const col = (k, d = 4) => f.map((fr) => r(fr[k], d));
  return {
    format: FORMAT, version: VERSION, name: flight.name, kind: flight.kind, orient: flight.orient,
    savedAt: new Date().toISOString(),
    meta: flight.meta,
    events: flight.events.map((e) => ({ name: e.name, t: r(e.t), ...(e.label ? { label: e.label } : {}), ...(e.source ? { source: e.source } : {}) })),
    series: {
      t: col('t', 4), alt: col('alt', 3), vAlt: col('vAlt', 3), acc: col('acc', 3), x: col('x', 3), y: col('y', 3),
      vx: col('vx', 3), vy: col('vy', 3), pitch: col('pitch', 2), roll: col('roll', 2), yaw: col('yaw', 2),
    },
  };
}

export function validateRecord(rec) {
  if (!rec || typeof rec !== 'object') throw new Error('Not a flight record.');
  if (rec.format !== FORMAT) throw new Error(`Unsupported format "${rec.format}" (expected "${FORMAT}").`);
  if (typeof rec.version !== 'number' || rec.version > VERSION) throw new Error(`Unsupported version ${rec.version}.`);
  const s = rec.series;
  if (!s || !Array.isArray(s.t) || s.t.length < 2) throw new Error('Record has no usable time series.');
  for (const k of ['t', 'alt']) if (!Array.isArray(s[k]) || s[k].length !== s.t.length) throw new Error(`Series "${k}" is missing or has the wrong length.`);
  for (const k of Object.keys(s)) {
    if (!Array.isArray(s[k]) || s[k].length !== s.t.length) throw new Error(`Series "${k}" has the wrong length.`);
    if (!s[k].every(Number.isFinite)) throw new Error(`Series "${k}" contains non-numeric values.`);
  }
  for (let i = 1; i < s.t.length; i++) if (!(s.t[i] > s.t[i - 1])) throw new Error('Time values must be strictly increasing.');
  if (!Array.isArray(rec.events)) throw new Error('Record has no events array.');
  for (const e of rec.events) if (typeof e.name !== 'string' || !Number.isFinite(e.t)) throw new Error('Malformed event entry.');
  return rec;
}

export function flightFromRecord(rec) {
  validateRecord(rec);
  const s = rec.series;
  const g = (k, i) => (s[k] ? s[k][i] : 0);
  const frames = s.t.map((t, i) => ({
    t, alt: s.alt[i], vAlt: g('vAlt', i), acc: g('acc', i), x: g('x', i), y: g('y', i),
    vx: g('vx', i), vy: g('vy', i), pitch: g('pitch', i), roll: g('roll', i), yaw: g('yaw', i),
  }));
  return makeFlight({
    name: String(rec.name || 'Flight'), kind: rec.kind === 'sim' ? 'sim' : 'data', frames, events: rec.events,
    meta: rec.meta || {}, orient: rec.orient === 'velocity' ? 'velocity' : 'euler',
  });
}

export function exportJSON(flights) {
  const recs = flights.map(flightToRecord);
  if (recs.length === 1) return JSON.stringify(recs[0]);
  return JSON.stringify({ format: FORMAT_MULTI, version: VERSION, flights: recs });
}

export function safeFileName(name) {
  return String(name || 'flight').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'flight';
}

export class FlightStore {
  constructor(storage) { this.storage = storage; }

  _read() {
    try {
      const raw = this.storage && this.storage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  _write(list) {
    try {
      this.storage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch { return false; }
  }

  list() { return this._read().map((e) => ({ id: e.id, name: e.name, kind: e.record.kind, savedAt: e.savedAt, apogee: e.apogee })); }

  save(flight, name) {
    const list = this._read();
    const rec = flightToRecord({ ...flight, name: name || flight.name });
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.push({ id, name: rec.name, savedAt: rec.savedAt, apogee: flight.stats ? flight.stats.apogee : null, record: rec });
    if (!this._write(list)) throw new Error('Could not save: browser storage is full or unavailable. Use Export instead.');
    return id;
  }

  get(id) {
    const e = this._read().find((x) => x.id === id);
    return e ? flightFromRecord(e.record) : null;
  }

  remove(id) { return this._write(this._read().filter((x) => x.id !== id)); }
}
