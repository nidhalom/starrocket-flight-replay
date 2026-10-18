// Flight model: builds a uniform "Flight" object from simulation output or imported data.
// Pure, no DOM.
import { toSI } from './units.js';
import { detectEvents, mergeEvents, canonicalEventName, isIgnorableLabel, padBaseline, sortEvents, phaseAt } from './events.js';
import { simulate } from './physics.js';

const LERP_KEYS = ['x', 'y', 'alt', 'vAlt', 'acc', 'vx', 'vy', 'pitch', 'roll', 'yaw'];

export function movingAverage(a, w) {
  const win = Math.max(1, Math.floor(w) | 1);
  if (win <= 1) return a.slice();
  const h = win >> 1;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++) { s += a[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

// Central differences on a possibly non-uniform time axis.
export function derivative(t, a) {
  const n = a.length;
  const d = new Array(n).fill(0);
  if (n < 2) return d;
  d[0] = (a[1] - a[0]) / (t[1] - t[0]);
  d[n - 1] = (a[n - 1] - a[n - 2]) / (t[n - 1] - t[n - 2]);
  for (let i = 1; i < n - 1; i++) d[i] = (a[i + 1] - a[i - 1]) / (t[i + 1] - t[i - 1]);
  return d;
}

// Equirectangular projection around the first fix: x = east, y = north (metres).
export function toLocalXY(lat, lon, lat0, lon0) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  return { x: (lon - lon0) * rad * R * Math.cos(lat0 * rad), y: (lat - lat0) * rad * R };
}

// Wind-drift estimate for flights without GPS: horizontal speed is a fraction of the wind
// (5% under boost/coast, 30% between apogee and first chute, 100% under canopy, 0 once landed).
export function estimateDrift(t, events, wind) {
  const ev = Object.fromEntries(events.map((e) => [e.name, e.t]));
  const speed = wind && wind.speed > 0 ? wind.speed : 0;
  const dir = ((wind && wind.dir) || 0) * (Math.PI / 180);
  const wx = speed * Math.sin(dir), wy = speed * Math.cos(dir);
  const chute = Math.min(ev.drogue ?? Infinity, ev.main ?? Infinity);
  const x = [0], y = [0];
  for (let i = 1; i < t.length; i++) {
    const tm = (t[i] + t[i - 1]) / 2;
    let k = 0.05;
    if (ev.landing !== undefined && tm >= ev.landing) k = 0;
    else if (tm >= chute) k = 1;
    else if (ev.apogee !== undefined && tm >= ev.apogee) k = 0.3;
    else if (ev.liftoff !== undefined && tm < ev.liftoff) k = 0;
    const dt = t[i] - t[i - 1];
    x.push(x[i - 1] + wx * k * dt);
    y.push(y[i - 1] + wy * k * dt);
  }
  return { x, y };
}

export function computeStats(frames, events) {
  let ap = frames[0], maxV = -Infinity, minV = Infinity, maxA = -Infinity, minA = Infinity, range = 0;
  for (const f of frames) {
    if (f.alt > ap.alt) ap = f;
    if (f.vAlt > maxV) maxV = f.vAlt;
    if (f.vAlt < minV) minV = f.vAlt;
    if (f.acc > maxA) maxA = f.acc;
    if (f.acc < minA) minA = f.acc;
    range = Math.max(range, Math.hypot(f.x, f.y));
  }
  const ev = Object.fromEntries(events.map((e) => [e.name, e.t]));
  const last = frames[frames.length - 1];
  const flightTime = ev.landing !== undefined && ev.liftoff !== undefined ? ev.landing - ev.liftoff : null;
  return {
    apogee: ap.alt, apogeeT: ap.t, maxVel: maxV, maxDescent: minV, maxAcc: maxA, minAcc: minA,
    maxRange: range, landingRange: Math.hypot(last.x, last.y), flightTime, duration: last.t,
  };
}

// frames: array of {t,x,y,alt,vAlt,acc,vx,vy,pitch,roll,yaw}; phase is (re)assigned from events.
export function makeFlight({ name, kind, frames, events, meta = {}, orient = 'euler' }) {
  if (!frames || frames.length < 2) throw new Error('A flight needs at least 2 samples.');
  const evs = sortEvents(events);
  const fr = frames.map((f) => ({ pitch: 0, roll: 0, yaw: 0, vx: 0, vy: 0, ...f, phase: phaseAt(evs, f.t) }));
  return {
    name, kind, frames: fr, events: evs, meta: { warnings: [], ...meta }, orient,
    duration: fr[fr.length - 1].t, stats: computeStats(fr, evs),
  };
}

export function flightFromSim(params, name = 'Simulation') {
  const sim = simulate(params);
  return makeFlight({
    name, kind: 'sim', frames: sim.frames, events: sim.events,
    meta: { source: 'simulation', params: sim.params, warnings: sim.warnings, hasGps: false, driftEstimated: true },
    orient: 'euler',
  });
}

// opts: { units:{time,length,velocity,accel}, smoothing (odd window, 1 = off), zeroAltitude,
//         trim, wind:{speed,dir}, name }
export function buildDataFlight(series, opts = {}) {
  const units = { time: 's', length: 'm', velocity: 'm/s', accel: 'm/s2', ...(opts.units || {}) };
  const warnings = [];
  const n0 = series.time.length;
  const idx = [];
  for (let i = 0; i < n0; i++) if (Number.isFinite(series.time[i]) && Number.isFinite(series.altitude[i])) idx.push(i);
  idx.sort((a, b) => series.time[a] - series.time[b]);
  const keep = [];
  let lastT = -Infinity;
  for (const i of idx) {
    const tt = toSI('time', series.time[i], units.time);
    if (tt > lastT) { keep.push(i); lastT = tt; }
  }
  if (keep.length < idx.length) warnings.push(`${idx.length - keep.length} duplicate/out-of-order timestamps dropped`);
  if (n0 - idx.length > 0) warnings.push(`${n0 - idx.length} rows skipped (non-numeric time or altitude)`);
  if (keep.length < 5) throw new Error('Not enough valid samples (need at least 5 rows with numeric time and altitude).');

  let t = keep.map((i) => toSI('time', series.time[i], units.time));
  const t00 = t[0];
  t = t.map((v) => v - t00);
  let alt = keep.map((i) => toSI('length', series.altitude[i], units.length));
  const win = opts.smoothing && opts.smoothing > 1 ? opts.smoothing : 1;

  const baseAlt = padBaseline(alt);
  if (opts.zeroAltitude !== false) alt = alt.map((v) => v - baseAlt);
  const altS = movingAverage(alt, win);
  // derived velocity/acceleration need more smoothing than the altitude trace itself (about 0.5 s)
  const rate0 = (t.length - 1) / (t[t.length - 1] - t[0]);
  const dvWin = Math.max(win, Math.round(rate0 * 0.5) | 1);

  let derivedVel = false, derivedAcc = false;
  let vel;
  if (series.velocity && keep.some((i) => Number.isFinite(series.velocity[i]))) {
    vel = movingAverage(fillGaps(keep.map((i) => toSI('velocity', series.velocity[i], units.velocity))), win);
  } else {
    vel = derivative(t, movingAverage(alt, dvWin));
    derivedVel = true;
  }
  let acc;
  if (series.acceleration && keep.some((i) => Number.isFinite(series.acceleration[i]))) {
    acc = movingAverage(fillGaps(keep.map((i) => toSI('accel', series.acceleration[i], units.accel))), win);
  } else {
    acc = derivative(t, movingAverage(vel, derivedVel ? dvWin : win));
    derivedAcc = true;
  }

  // events
  // detection works on a ~0.8 s smoothed view so sensor noise does not look like chute openings
  const rateHz0 = (t.length - 1) / (t[t.length - 1] - t[0]);
  const dWin = Math.max(win, Math.round(rateHz0 * 0.8) | 1);
  const detAlt = movingAverage(alt, dWin);
  const detected = detectEvents({ t, alt: detAlt, vel: derivedVel ? derivative(t, detAlt) : movingAverage(vel, dWin) });
  const labelled = [];
  for (const l of series.labels || []) {
    if (isIgnorableLabel(l.label) || !Number.isFinite(l.t)) continue;
    const lt = toSI('time', l.t, units.time) - t00;
    const name = canonicalEventName(l.label);
    labelled.push(name ? { name, t: lt, source: 'data', label: l.label } : { name: 'custom', t: lt, source: 'data', label: l.label });
  }
  let events = mergeEvents(detected, labelled);

  // GPS
  let hasGps = false;
  let x, y;
  if (series.lat && series.lon) {
    const la = keep.map((i) => series.lat[i]);
    const lo = keep.map((i) => series.lon[i]);
    const ok = (k) => Number.isFinite(la[k]) && Number.isFinite(lo[k]) && Math.abs(la[k]) <= 90 && Math.abs(lo[k]) <= 180;
    const valid = la.map((_, k) => ok(k));
    if (valid.filter(Boolean).length >= 3) {
      hasGps = true;
      const first = valid.indexOf(true);
      const lat0 = la[first], lon0 = lo[first];
      let last = first;
      x = []; y = [];
      for (let k = 0; k < la.length; k++) {
        if (valid[k]) last = k;
        const p = toLocalXY(la[last], lo[last], lat0, lon0);
        x.push(p.x); y.push(p.y);
      }
      const sm = Math.max(3, win);
      x = movingAverage(x, sm); y = movingAverage(y, sm);
    }
  }
  if (!hasGps) {
    const d = estimateDrift(t, events, opts.wind);
    x = d.x; y = d.y;
  }
  const vx = derivative(t, x), vy = derivative(t, y);

  let frames = t.map((tt, k) => ({
    t: tt, x: x[k], y: y[k], alt: Math.max(altS[k], 0), vAlt: vel[k], acc: acc[k], vx: vx[k], vy: vy[k], pitch: 0, roll: 0, yaw: 0,
  }));

  if (opts.trim !== false) {
    const lift = events.find((e) => e.name === 'liftoff');
    const land = events.find((e) => e.name === 'landing');
    const t0 = lift ? Math.max(0, lift.t - 1) : 0;
    const t1 = land ? land.t + 2 : Infinity;
    frames = frames.filter((f) => f.t >= t0 && f.t <= t1);
    if (frames.length >= 5 && t0 > 0) {
      frames = frames.map((f) => ({ ...f, t: f.t - t0 }));
      events = events.map((e) => ({ ...e, t: e.t - t0 }));
    }
    if (frames.length >= 2 && t1 !== Infinity) events = events.filter((e) => e.t <= frames[frames.length - 1].t + 1e-9);
  }
  if (!events.some((e) => e.name === 'apogee')) warnings.push('No apogee detected: altitude never rose clearly above the baseline');
  if (hasGps) {
    const x0 = frames[0].x, y0 = frames[0].y;
    frames = frames.map((f) => ({ ...f, x: f.x - x0, y: f.y - y0 }));
  }
  const rate = frames.length > 1 ? (frames.length - 1) / (frames[frames.length - 1].t - frames[0].t) : 0;
  return makeFlight({
    name: opts.name || 'Imported flight', kind: 'data', frames, events, orient: 'velocity',
    meta: {
      source: 'data', units, hasGps, driftEstimated: !hasGps, derivedVelocity: derivedVel, derivedAcceleration: derivedAcc,
      smoothing: win, sampleCount: frames.length, rateHz: +rate.toFixed(2), baselineAltitude: opts.zeroAltitude !== false ? baseAlt : 0,
      wind: hasGps ? null : opts.wind || { speed: 0, dir: 0 }, warnings,
    },
  });
}

function fillGaps(a) {
  const out = a.slice();
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) last = out[i]; else out[i] = last;
  }
  return out;
}

export function sampleAt(flight, time) {
  const f = flight.frames;
  const n = f.length;
  if (time <= f[0].t) return { ...f[0], t: time, phase: phaseAt(flight.events, time) };
  if (time >= f[n - 1].t) return { ...f[n - 1], t: time, phase: phaseAt(flight.events, time) };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t <= time) lo = mid; else hi = mid;
  }
  const a = (time - f[lo].t) / (f[hi].t - f[lo].t);
  const out = { t: time, phase: phaseAt(flight.events, time) };
  for (const k of LERP_KEYS) out[k] = f[lo][k] + (f[hi][k] - f[lo][k]) * a;
  return out;
}

export function frameIndexAt(flight, time) {
  const f = flight.frames;
  let lo = 0, hi = f.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t <= time) lo = mid; else hi = mid;
  }
  return time >= f[hi].t ? hi : lo;
}
