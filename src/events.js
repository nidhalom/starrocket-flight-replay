// Flight event detection and phase naming. Pure, no DOM.

export const EVENT_ORDER = ['liftoff', 'burnout', 'apogee', 'drogue', 'main', 'landing'];
export const EVENT_LABELS = {
  liftoff: 'Liftoff', burnout: 'Burnout', apogee: 'Apogee', drogue: 'Drogue deploy', main: 'Main deploy', landing: 'Landing',
};
export const PHASE_BY_EVENT = { liftoff: 'BOOST', burnout: 'COAST', apogee: 'DESCENT', drogue: 'DROGUE', main: 'MAIN', landing: 'LANDED' };

export function median(a) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Pad baseline: median of the first samples when they are flat (rocket sitting on the pad);
// if the data starts mid-boost the first sample is the best available baseline.
export function padBaseline(alt) {
  const head = alt.slice(0, Math.min(alt.length, 10)).filter(Number.isFinite);
  if (!head.length) return 0;
  const range = Math.max(...head) - Math.min(...head);
  return range <= 3 ? median(head) : head[0];
}

export function sortEvents(events) {
  const rank = (e) => { const i = EVENT_ORDER.indexOf(e.name); return i < 0 ? 99 : i; };
  return [...events].sort((a, b) => a.t - b.t || rank(a) - rank(b));
}

export function phaseAt(events, t) {
  let phase = 'PAD';
  for (const e of sortEvents(events)) {
    if (e.t <= t + 1e-9 && PHASE_BY_EVENT[e.name]) phase = PHASE_BY_EVENT[e.name];
  }
  return phase;
}

// Map a free-text label from an "event/state" column to a canonical event name, or null.
export function canonicalEventName(label) {
  const s = String(label).toLowerCase();
  if (/drogue|apogee\s*(chute|deploy|charge)/.test(s)) return 'drogue';
  if (/main/.test(s)) return 'main';
  if (/apogee|peak|coast.?end/.test(s)) return 'apogee';
  if (/burn.?out|motor.?(out|end)|cut.?off|meco|coast/.test(s)) return 'burnout';
  if (/launch|lift.?off|ignit|boost/.test(s)) return 'liftoff';
  if (/land|touch.?down|recover/.test(s)) return 'landing';
  return null;
}

export function isIgnorableLabel(label) {
  return /^(pad|idle|ready|armed|wait(ing)?|init|standby)$/i.test(String(label).trim());
}

function crossTime(t, a, i, level) {
  // time at which series a crosses `level` between sample i-1 and i (linear)
  const a0 = a[i - 1], a1 = a[i];
  if (a1 === a0) return t[i];
  const f = (level - a0) / (a1 - a0);
  return t[i - 1] + Math.min(1, Math.max(0, f)) * (t[i] - t[i - 1]);
}

// Detect events from (already smoothed, SI) series.
// Input: { t[], alt[] (AGL, m), vel[] (m/s vertical) }.
// Heuristics (documented in docs/CSV_FORMAT.md):
//  liftoff  = altitude first rises more than max(3 m, 0.5% of apogee) above the pad baseline
//  burnout  = time of peak vertical velocity between liftoff and apogee
//  apogee   = time of maximum altitude
//  deploy   = after apogee, the descent speed drops by more than max(3 m/s, 30%) within 2 s
//             while falling faster than 5 m/s. Two clusters -> drogue then main; one cluster ->
//             main if below half of apogee altitude, otherwise drogue.
//  landing  = first time after apogee when altitude returns within max(1.5 m, 0.3% of apogee) of the baseline
export function detectEvents({ t, alt, vel }) {
  const n = t.length;
  const events = [];
  if (n < 3) return events;
  const base = padBaseline(alt);
  let iAp = 0;
  for (let i = 1; i < n; i++) if (alt[i] > alt[iAp]) iAp = i;
  const apH = alt[iAp] - base;
  if (!(apH > 1)) return events; // never left the ground

  const liftThr = Math.max(3, 0.005 * apH);
  let iLift = -1;
  for (let i = 0; i <= iAp; i++) if (alt[i] - base > liftThr) { iLift = i; break; }
  if (iLift > 0) events.push({ name: 'liftoff', t: crossTime(t, alt, iLift, base + liftThr), source: 'detected' });
  else iLift = 0;

  let iBo = iLift;
  for (let i = iLift; i <= iAp; i++) if (vel[i] > vel[iBo]) iBo = i;
  if (iBo > iLift && iBo < iAp) events.push({ name: 'burnout', t: t[iBo], source: 'detected' });

  events.push({ name: 'apogee', t: t[iAp], source: 'detected' });

  const landThr = Math.max(1.5, 0.003 * apH);
  let iLand = -1;
  for (let i = iAp + 1; i < n; i++) if (alt[i] - base <= landThr) { iLand = i; break; }
  const end = iLand > 0 ? iLand : n - 1;
  if (iLand > 0) events.push({ name: 'landing', t: t[iLand], source: 'detected' });

  // chute deployments: the descent speed drops sharply (by > max(3 m/s, 30%)) within 2 s
  const idxAt = (i, dtw) => { let j = i; while (j < n - 1 && t[j] - t[i] < dtw) j++; return j; };
  const flagged = [];
  for (let i = iAp + 1; i < end; i++) {
    if (vel[i] < -5) {
      const j = idxAt(i, 2);
      if (vel[j] - vel[i] > Math.max(3, 0.3 * -vel[i])) flagged.push(i);
    }
  }
  const clusters = [];
  for (const i of flagged) {
    const c = clusters[clusters.length - 1];
    if (c && t[i] - t[c.last] < 2.5) c.last = i;
    else clusters.push({ first: i, last: i });
  }
  for (const c of clusters) {
    // strongest 1 s rise of vertical velocity inside the cluster marks the deployment
    let bestK = c.first, bestRise = -Infinity;
    for (let k = c.first; k <= Math.min(c.last + 1, n - 1); k++) {
      const rise = vel[idxAt(k, 1)] - vel[k];
      if (rise > bestRise) { bestRise = rise; bestK = k; }
    }
    c.t = t[bestK];
    c.i = bestK;
  }
  // ignore "deployments" in the last metres of the descent (touchdown / sensor noise)
  for (let k = clusters.length - 1; k >= 0; k--) {
    if (alt[clusters[k].i] - base < Math.max(15, 0.02 * apH)) clusters.splice(k, 1);
  }
  if (clusters.length >= 2) {
    events.push({ name: 'drogue', t: clusters[0].t, source: 'detected' });
    events.push({ name: 'main', t: clusters[clusters.length - 1].t, source: 'detected' });
  } else if (clusters.length === 1) {
    const h = alt[clusters[0].i] - base;
    events.push({ name: h < 0.5 * apH ? 'main' : 'drogue', t: clusters[0].t, source: 'detected' });
  }
  return sortEvents(events);
}

// Labelled events from the data override detected events of the same name.
export function mergeEvents(detected, labelled) {
  const byName = new Map();
  for (const e of detected) byName.set(e.name, e);
  const custom = [];
  for (const e of labelled) {
    if (e.name === 'custom') custom.push(e);
    else byName.set(e.name, e);
  }
  return sortEvents([...byName.values(), ...custom]);
}
