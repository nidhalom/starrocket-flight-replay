import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, sanitizeParams, DEFAULT_PARAMS, terminalVelocity, airDensity, G } from '../src/physics.js';

const ev = (r) => Object.fromEntries(r.events.map((e) => [e.name, e.t]));

test('default flight has the expected event sequence and lands', () => {
  const r = simulate();
  const e = ev(r);
  assert.deepEqual(r.events.map((x) => x.name), ['liftoff', 'burnout', 'apogee', 'drogue', 'main', 'landing']);
  assert.equal(e.burnout, DEFAULT_PARAMS.burnTime);
  assert.ok(e.apogee > e.burnout && e.main > e.apogee && e.landing > e.main);
  const last = r.frames[r.frames.length - 1];
  assert.equal(last.alt, 0);
  assert.equal(last.phase, 'LANDED');
  assert.deepEqual(r.warnings, []);
});

test('simulation is deterministic', () => {
  assert.deepEqual(simulate({ thrust: 300 }).frames, simulate({ thrust: 300 }).frames);
});

test('altitude rises until apogee then falls; apogee frame is the maximum', () => {
  const r = simulate();
  const apT = ev(r).apogee;
  const maxAlt = Math.max(...r.frames.map((f) => f.alt));
  const apFrame = r.frames.reduce((a, b) => (b.alt > a.alt ? b : a));
  assert.ok(Math.abs(apFrame.t - apT) < 0.1);
  assert.ok(maxAlt > 100);
  for (const f of r.frames) if (f.t < apT - 0.1 && f.t > 0.05) assert.ok(f.vAlt > 0);
});

test('drag lowers apogee; more thrust raises it', () => {
  const apogee = (p) => Math.max(...simulate(p).frames.map((f) => f.alt));
  assert.ok(apogee({ cd: 1.2 }) < apogee({ cd: 0.3 }));
  assert.ok(apogee({ thrust: 400 }) > apogee({ thrust: 260 }));
  assert.ok(apogee({ mass: 4 }) < apogee({ mass: 2.5 }));
});

test('descent speed approaches terminal velocity under drogue and main', () => {
  const p = { ...DEFAULT_PARAMS, mainDeployAlt: 5 }; // keep main out of the way: nearly all descent on drogue
  const r = simulate(p);
  const e = ev(r);
  const mid = r.frames.find((f) => f.t > e.drogue + 20 && f.alt > 100 && f.alt < 400);
  const vt = terminalVelocity(p.mass, p.drogueCdA + 0.5 * Math.PI * 0.01 / 4, mid.alt);
  assert.ok(Math.abs(-mid.vAlt - vt) / vt < 0.1, `${-mid.vAlt} vs ${vt}`);
  // slower under main
  const full = simulate();
  const fe = ev(full);
  const underMain = full.frames.find((f) => f.t > fe.main + 8 && f.alt > 20);
  assert.ok(-underMain.vAlt < 8);
});

test('main deploys at the requested altitude (within one frame of descent)', () => {
  const r = simulate({ mainDeployAlt: 400 });
  const t = ev(r).main;
  const f = r.frames.find((x) => x.t >= t);
  assert.ok(Math.abs(f.alt - 400) < 5, String(f.alt));
});

test('drogue deploy altitude above 0 delays the drogue', () => {
  const r = simulate({ drogueDeployAlt: 600 });
  const e = ev(r);
  assert.ok(e.drogue > e.apogee);
  assert.equal(r.frames.find((f) => f.t > e.apogee + 0.2).phase, 'DESCENT');
});

test('wind drives downrange drift in the right direction; no wind means no drift', () => {
  const east = simulate({ windSpeed: 8, windDir: 90 });
  const last = east.frames[east.frames.length - 1];
  assert.ok(last.x > 50 && Math.abs(last.y) < 1);
  const north = simulate({ windSpeed: 8, windDir: 0 });
  const ln = north.frames[north.frames.length - 1];
  assert.ok(ln.y > 50 && Math.abs(ln.x) < 1);
  const calm = simulate({ windSpeed: 0 });
  const lc = calm.frames[calm.frames.length - 1];
  assert.ok(Math.hypot(lc.x, lc.y) < 1e-6);
});

test('sanitizeParams clamps and warns', () => {
  const { params, warnings } = sanitizeParams({ burnTime: -5, mass: 'abc', thrust: 1e9 });
  assert.equal(params.burnTime, 0.1);
  assert.equal(params.mass, DEFAULT_PARAMS.mass);
  assert.equal(params.thrust, 20000);
  assert.equal(warnings.length, 3);
});

test('thrust below weight stays on the pad with a warning', () => {
  const r = simulate({ thrust: 10, mass: 5 });
  assert.equal(r.events.length, 0);
  assert.ok(r.warnings.some((w) => /pad/.test(w)));
  assert.ok(r.frames.every((f) => f.alt === 0));
});

test('air density and terminal velocity are sane', () => {
  assert.ok(Math.abs(airDensity(0) - 1.225) < 1e-9);
  assert.ok(airDensity(3000) < airDensity(0));
  const vt = terminalVelocity(2.5, 2, 0);
  assert.ok(Math.abs(vt - Math.sqrt((2 * 2.5 * G) / (1.225 * 2))) < 1e-9);
});
