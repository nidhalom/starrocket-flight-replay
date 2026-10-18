import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightStore, flightToRecord, flightFromRecord, validateRecord, exportJSON, safeFileName } from '../src/storage.js';
import { flightFromSim } from '../src/flight.js';
import { parseJSONInput } from '../src/csv.js';

class FakeStorage {
  constructor() { this.m = new Map(); this.full = false; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.full) throw new Error('quota'); this.m.set(k, v); }
}

test('record round trip keeps events, stats and series', () => {
  const f = flightFromSim({});
  const g = flightFromRecord(JSON.parse(JSON.stringify(flightToRecord(f))));
  assert.equal(g.kind, 'sim');
  assert.equal(g.frames.length, f.frames.length);
  assert.deepEqual(g.events.map((e) => e.name), f.events.map((e) => e.name));
  assert.ok(Math.abs(g.stats.apogee - f.stats.apogee) < 0.01);
});

test('store: save, list, get, remove', () => {
  const store = new FlightStore(new FakeStorage());
  const f = flightFromSim({});
  const id = store.save(f, 'Test A');
  const id2 = store.save(f, 'Test B');
  assert.deepEqual(store.list().map((x) => x.name), ['Test A', 'Test B']);
  assert.equal(store.get(id).name, 'Test A');
  assert.ok(store.remove(id));
  assert.deepEqual(store.list().map((x) => x.id), [id2]);
  assert.equal(store.get('nope'), null);
});

test('store: full storage reports a clear error; corrupt storage reads as empty', () => {
  const fs = new FakeStorage();
  fs.full = true;
  assert.throws(() => new FlightStore(fs).save(flightFromSim({}), 'x'), /storage is full/);
  const bad = new FakeStorage();
  bad.setItem('starrocket.flights.v1', '{not json');
  assert.deepEqual(new FlightStore(bad).list(), []);
  assert.deepEqual(new FlightStore(null).list(), []);
});

test('export / import file round trip via parseJSONInput', () => {
  const f = flightFromSim({});
  const single = parseJSONInput(exportJSON([f]));
  assert.equal(single.type, 'records');
  assert.equal(flightFromRecord(single.records[0]).name, f.name);
  const multi = parseJSONInput(exportJSON([f, f]));
  assert.equal(multi.records.length, 2);
});

test('validateRecord rejects malformed files', () => {
  const good = flightToRecord(flightFromSim({}));
  assert.doesNotThrow(() => validateRecord(good));
  assert.throws(() => validateRecord(null), /Not a flight/);
  assert.throws(() => validateRecord({ ...good, format: 'other' }), /Unsupported format/);
  assert.throws(() => validateRecord({ ...good, version: 99 }), /Unsupported version/);
  assert.throws(() => validateRecord({ ...good, series: { ...good.series, alt: [1, 2] } }), /wrong length|missing/);
  const t = good.series.t.slice();
  t[3] = t[2];
  assert.throws(() => validateRecord({ ...good, series: { ...good.series, t } }), /increasing/);
  assert.throws(() => validateRecord({ ...good, events: [{ name: 5 }] }), /Malformed/);
});

test('safeFileName', () => {
  assert.equal(safeFileName('My Flight #1!'), 'my-flight-1');
  assert.equal(safeFileName(''), 'flight');
});
