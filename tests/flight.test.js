import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate } from '../src/physics.js';
import { movingAverage, derivative, toLocalXY, estimateDrift, buildDataFlight, flightFromSim, sampleAt } from '../src/flight.js';
import { detectEvents, canonicalEventName, phaseAt, mergeEvents } from '../src/events.js';
import { parseCSV, detectColumns, extractSeries } from '../src/csv.js';

function rng(seed) {
  let a = seed;
  return () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; };
}

// build a raw "altimeter" series from the simulator: noisy altitude only, in feet + ms
function altOnlySeries(params, hz = 20, noiseM = 0.8, seed = 7) {
  const sim = simulate(params);
  const r = rng(seed);
  const time = [], altitude = [];
  const end = sim.frames[sim.frames.length - 1].t;
  let j = 0;
  for (let t = 0; t <= end; t += 1 / hz) {
    while (j < sim.frames.length - 2 && sim.frames[j + 1].t < t) j++;
    const a = sim.frames[j], b = sim.frames[j + 1];
    const f = (t - a.t) / (b.t - a.t);
    const alt = a.alt + (b.alt - a.alt) * f + (r() - 0.5) * 2 * noiseM;
    time.push(t * 1000);
    altitude.push(alt / 0.3048);
  }
  return { sim, series: { time, altitude, velocity: null, acceleration: null, lat: null, lon: null, labels: [] } };
}

test('movingAverage and derivative', () => {
  assert.deepEqual(movingAverage([1, 2, 3], 1), [1, 2, 3]);
  const m = movingAverage([0, 0, 9, 0, 0], 3);
  assert.deepEqual(m, [0, 3, 3, 3, 0]);
  const t = [0, 1, 2, 3, 4];
  const d = derivative(t, [0, 2, 4, 6, 8]);
  assert.ok(d.every((v) => Math.abs(v - 2) < 1e-12));
  const nu = derivative([0, 1, 3], [0, 1, 3]);
  assert.ok(nu.every((v) => Math.abs(v - 1) < 1e-12));
});

test('toLocalXY: 1 degree of latitude is about 111 km north', () => {
  const p = toLocalXY(1, 0, 0, 0);
  assert.ok(Math.abs(p.y - 111195) < 100);
  assert.ok(Math.abs(p.x) < 1e-6);
  const q = toLocalXY(0, 0.001, 0, 0);
  assert.ok(q.x > 100 && q.x < 112);
});

test('canonicalEventName', () => {
  assert.equal(canonicalEventName('DROGUE_DEPLOY'), 'drogue');
  assert.equal(canonicalEventName('Main chute'), 'main');
  assert.equal(canonicalEventName('Apogee'), 'apogee');
  assert.equal(canonicalEventName('BURNOUT'), 'burnout');
  assert.equal(canonicalEventName('Launch detect'), 'liftoff');
  assert.equal(canonicalEventName('touchdown'), 'landing');
  assert.equal(canonicalEventName('weird'), null);
});

test('phaseAt follows event order', () => {
  const ev = [{ name: 'liftoff', t: 1 }, { name: 'apogee', t: 5 }, { name: 'drogue', t: 5 }, { name: 'main', t: 9 }];
  assert.equal(phaseAt(ev, 0), 'PAD');
  assert.equal(phaseAt(ev, 2), 'BOOST');
  assert.equal(phaseAt(ev, 5), 'DROGUE');
  assert.equal(phaseAt(ev, 10), 'MAIN');
});

test('event detection recovers apogee, burnout, deploys and landing from noisy altitude only (ft, ms)', () => {
  const { sim, series } = altOnlySeries({});
  const truth = Object.fromEntries(sim.events.map((e) => [e.name, e.t]));
  const f = buildDataFlight(series, { units: { time: 'ms', length: 'ft' }, smoothing: 5, trim: false });
  const got = Object.fromEntries(f.events.map((e) => [e.name, e.t]));
  assert.ok(Math.abs(got.apogee - truth.apogee) < 1.0, `apogee ${got.apogee} vs ${truth.apogee}`);
  assert.ok(Math.abs(f.stats.apogee - Math.max(...sim.frames.map((x) => x.alt))) < 5);
  assert.ok(got.liftoff !== undefined && got.liftoff < 1.5);
  assert.ok(Math.abs(got.burnout - truth.burnout) < 1.0, `burnout ${got.burnout}`);
  assert.ok(got.main !== undefined && Math.abs(got.main - truth.main) < 3, `main ${got.main} vs ${truth.main}`);
  assert.ok(Math.abs(got.landing - truth.landing) < 3);
  assert.equal(f.meta.derivedVelocity, true);
});

test('derived velocity matches true velocity within tolerance', () => {
  const { sim, series } = altOnlySeries({}, 20, 0.3);
  const f = buildDataFlight(series, { units: { time: 'ms', length: 'ft' }, smoothing: 5, trim: false });
  const at = 6;
  const truth = sim.frames.reduce((a, b) => (Math.abs(b.t - at) < Math.abs(a.t - at) ? b : a));
  const mine = sampleAt(f, truth.t);
  assert.ok(Math.abs(mine.vAlt - truth.vAlt) < 8, `${mine.vAlt} vs ${truth.vAlt}`);
});

test('unit conversion in buildDataFlight: feet/ms equals metres/s', () => {
  const t = [0, 100, 200, 300, 400, 500, 600];
  const altM = [0, 1, 5, 12, 20, 25, 27];
  const a = buildDataFlight({ time: t.map((x) => x / 1000), altitude: altM, labels: [] }, { trim: false, zeroAltitude: false });
  const b = buildDataFlight({ time: t, altitude: altM.map((x) => x / 0.3048), labels: [] }, { units: { time: 'ms', length: 'ft' }, trim: false, zeroAltitude: false });
  a.frames.forEach((fr, i) => {
    assert.ok(Math.abs(fr.alt - b.frames[i].alt) < 1e-9);
    assert.ok(Math.abs(fr.t - b.frames[i].t) < 1e-9);
  });
  assert.ok(Math.abs(b.stats.apogee - 27) < 1e-9);
});

test('provided velocity is used (and converted) instead of derived', () => {
  const s = {
    time: [0, 1, 2, 3, 4, 5], altitude: [0, 10, 25, 30, 25, 10],
    velocity: [0, 100, 50, 0, -50, -100], acceleration: null, labels: [],
  };
  const f = buildDataFlight(s, { units: { velocity: 'ft/s' }, trim: false, zeroAltitude: false });
  assert.equal(f.meta.derivedVelocity, false);
  assert.ok(Math.abs(f.frames[1].vAlt - 30.48) < 1e-9);
});

test('smoothing reduces noise in derived velocity', () => {
  const r = rng(3);
  const time = [], altitude = [];
  for (let i = 0; i < 200; i++) { time.push(i * 0.05); altitude.push(i * 0.05 * 10 + (r() - 0.5) * 2); }
  const raw = buildDataFlight({ time, altitude, labels: [] }, { smoothing: 1, trim: false, zeroAltitude: false });
  const sm = buildDataFlight({ time, altitude, labels: [] }, { smoothing: 31, trim: false, zeroAltitude: false });
  const dev = (f) => Math.max(...f.frames.slice(25, -25).map((x) => Math.abs(x.vAlt - 10)));
  assert.ok(dev(sm) < dev(raw) / 2);
});

test('too few samples / bad rows are reported', () => {
  assert.throws(() => buildDataFlight({ time: [0, 1], altitude: [0, 1], labels: [] }), /Not enough/);
  const s = { time: [0, 1, 2, 3, 4, 5, 6, NaN], altitude: [0, 1, 4, 9, 4, 1, 0, 3], labels: [] };
  const f = buildDataFlight(s, { trim: false, zeroAltitude: false });
  assert.ok(f.meta.warnings.some((w) => /skipped/.test(w)));
});

test('duplicate / out-of-order timestamps are dropped', () => {
  const s = { time: [0, 1, 1, 2, 3, 4, 5], altitude: [0, 1, 1, 4, 9, 4, 1], labels: [] };
  const f = buildDataFlight(s, { trim: false, zeroAltitude: false });
  assert.equal(f.frames.length, 6);
  assert.ok(f.meta.warnings.some((w) => /duplicate/.test(w)));
});

test('GPS path: lat/lon become local metres; without GPS a wind-drift estimate is used', () => {
  const { sim, series } = altOnlySeries({ windSpeed: 0 }, 10, 0.2);
  const n = series.time.length;
  series.lat = Array.from({ length: n }, (_, i) => (i / n) * 0.001);
  series.lon = Array.from({ length: n }, (_, i) => (i / n) * 0.002);
  const g = buildDataFlight(series, { units: { time: 'ms', length: 'ft' }, smoothing: 1, trim: false });
  assert.equal(g.meta.hasGps, true);
  const last = g.frames[g.frames.length - 1];
  assert.ok(last.y > 90 && last.y < 120, String(last.y));
  assert.ok(last.x > 190 && last.x < 240, String(last.x));

  delete series.lat; delete series.lon;
  const w = buildDataFlight(series, { units: { time: 'ms', length: 'ft' }, wind: { speed: 5, dir: 90 }, trim: false });
  assert.equal(w.meta.hasGps, false);
  assert.equal(w.meta.driftEstimated, true);
  const wl = w.frames[w.frames.length - 1];
  assert.ok(wl.x > 30 && Math.abs(wl.y) < 1e-6);
  assert.ok(sim.events.length > 0);
});

test('estimateDrift: zero wind means no drift, stops after landing', () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ev = [{ name: 'liftoff', t: 0 }, { name: 'apogee', t: 3 }, { name: 'main', t: 5 }, { name: 'landing', t: 8 }];
  const none = estimateDrift(t, ev, { speed: 0, dir: 0 });
  assert.ok(none.x.every((v) => v === 0));
  const d = estimateDrift(t, ev, { speed: 10, dir: 90 });
  assert.equal(d.x[10], d.x[8]);
  assert.ok(d.x[8] > d.x[3]);
});

test('labelled events from data override detected ones', () => {
  const merged = mergeEvents([{ name: 'apogee', t: 10 }, { name: 'landing', t: 50 }], [{ name: 'apogee', t: 10.5 }, { name: 'custom', t: 20, label: 'X' }]);
  assert.equal(merged.find((e) => e.name === 'apogee').t, 10.5);
  assert.equal(merged.length, 3);
});

test('sample files load end to end', () => {
  for (const [file, gps, units] of [['synthetic-baro-only.csv', false, { time: 'ms', length: 'ft' }], ['synthetic-gps-events.csv', true, null]]) {
    const parsed = parseCSV(readFileSync(new URL(`../samples/${file}`, import.meta.url), 'utf8'));
    const d = detectColumns(parsed.headers, parsed.rows);
    if (units) { assert.equal(d.units.time, units.time); assert.equal(d.units.length, units.length); }
    const f = buildDataFlight(extractSeries(parsed, d.mapping), { units: d.units, smoothing: 3, wind: { speed: 0, dir: 0 } });
    assert.equal(f.meta.hasGps, gps, file);
    assert.ok(f.stats.apogee > 500 && f.stats.apogee < 1500, `${file} apogee ${f.stats.apogee}`);
    for (const n of ['liftoff', 'apogee', 'landing']) assert.ok(f.events.some((e) => e.name === n), `${file} missing ${n}`);
  }
});

test('flightFromSim exposes stats', () => {
  const f = flightFromSim({});
  assert.equal(f.kind, 'sim');
  assert.ok(f.stats.apogee > 100);
  assert.ok(f.stats.flightTime > 20);
});

test('detectEvents returns nothing for a flat series', () => {
  const t = Array.from({ length: 50 }, (_, i) => i * 0.1);
  assert.deepEqual(detectEvents({ t, alt: t.map(() => 0), vel: t.map(() => 0) }), []);
});
