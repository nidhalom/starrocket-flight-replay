// Simulation-mode physics: a small 1-D vertical point-mass model with quadratic drag,
// a constant-thrust motor, drogue + main parachutes, and a simple wind-drift model.
// Pure functions, no DOM, deterministic (no randomness) so it can be unit tested.
//
// Simplifications (deliberate): constant mass (no propellant loss), exponential atmosphere,
// vertical flight (no gravity turn), horizontal motion = relaxation toward the wind speed.

export const G = 9.80665;
export const OUT_DT = 0.04; // output frame spacing, seconds
const SIM_DT = 0.005;
const STRIDE = Math.round(OUT_DT / SIM_DT);
const T_MAX = 900;

export const PARAM_SPECS = [
  { key: 'burnTime', label: 'Motor burn time', unit: 's', min: 0.1, max: 30, step: 0.1 },
  { key: 'thrust', label: 'Average thrust', unit: 'N', min: 1, max: 20000, step: 5 },
  { key: 'mass', label: 'Mass (constant)', unit: 'kg', min: 0.05, max: 500, step: 0.1 },
  { key: 'diameter', label: 'Body diameter', unit: 'm', min: 0.01, max: 1, step: 0.005 },
  { key: 'cd', label: 'Body drag coeff. Cd', unit: '', min: 0.05, max: 2, step: 0.05 },
  { key: 'drogueCdA', label: 'Drogue drag area Cd*A', unit: 'm2', min: 0.01, max: 20, step: 0.05 },
  { key: 'mainCdA', label: 'Main drag area Cd*A', unit: 'm2', min: 0.05, max: 100, step: 0.1 },
  { key: 'drogueDeployAlt', label: 'Drogue deploy altitude (0 = apogee)', unit: 'm', min: 0, max: 50000, step: 10 },
  { key: 'mainDeployAlt', label: 'Main deploy altitude', unit: 'm', min: 5, max: 50000, step: 10 },
  { key: 'windSpeed', label: 'Wind speed', unit: 'm/s', min: 0, max: 40, step: 0.5 },
  { key: 'windDir', label: 'Wind blows toward (0 = N, 90 = E)', unit: 'deg', min: 0, max: 360, step: 1 },
];

export const DEFAULT_PARAMS = Object.freeze({
  burnTime: 2.0,
  thrust: 260,
  mass: 2.5,
  diameter: 0.1,
  cd: 0.5,
  drogueCdA: 0.25,
  mainCdA: 2.0,
  drogueDeployAlt: 0,
  mainDeployAlt: 300,
  windSpeed: 4,
  windDir: 57,
});

export function airDensity(alt) {
  return 1.225 * Math.exp(-Math.max(alt, 0) / 8500);
}

export function sanitizeParams(input = {}) {
  const warnings = [];
  const params = {};
  for (const s of PARAM_SPECS) {
    let v = Number(input[s.key]);
    if (input[s.key] === undefined || input[s.key] === '' || !Number.isFinite(v)) {
      if (input[s.key] !== undefined && input[s.key] !== '') warnings.push(`${s.label}: not a number, using default`);
      v = DEFAULT_PARAMS[s.key];
    }
    if (v < s.min) { warnings.push(`${s.label}: raised to minimum ${s.min}`); v = s.min; }
    if (v > s.max) { warnings.push(`${s.label}: lowered to maximum ${s.max}`); v = s.max; }
    params[s.key] = v;
  }
  return { params, warnings };
}

const rad = (d) => (d * Math.PI) / 180;

// Scripted attitude (degrees) per phase; cosmetic, carried over from the original demo.
function attitude(phase, tp, burn) {
  switch (phase) {
    case 'BOOST': {
      const p = Math.min(1, tp / burn);
      return { pitch: 4 + 1.2 * Math.sin(tp * 9), rollRate: 600 * p, yaw: 1.5 * Math.sin(tp * 5) };
    }
    case 'COAST':
      return { pitch: 4 + 3 * Math.sin(tp * 0.6) * Math.exp(-tp * 0.04), rollRate: 600 * Math.exp(-tp * 0.12), yaw: 2 * Math.sin(tp * 0.35) };
    case 'MAIN':
      return { pitch: 25 + 15 * Math.sin(tp * 0.7) * Math.exp(-tp * 0.05), rollRate: 2 * Math.sin(tp * 0.6), yaw: 3 * Math.sin(tp * 0.2) };
    default: // DESCENT / DROGUE
      return {
        pitch: 4 + 88 * Math.min(1, tp / 4) + 8 * Math.sin(tp * 0.9),
        rollRate: 66.5 * Math.exp(-tp * 0.3) + 3 * Math.sin(tp * 0.8),
        yaw: 4 * Math.sin(tp * 0.25),
      };
  }
}

export function simulate(input = {}) {
  const { params: p, warnings } = sanitizeParams(input);

  // A rocket that cannot out-thrust its own weight stays on the pad.
  if (p.thrust / p.mass <= G) {
    warnings.push('Thrust-to-weight is 1 or less: the rocket does not leave the pad.');
    const frames = [];
    for (let t = 0; t <= 2 + 1e-9; t += OUT_DT) {
      frames.push({ t, x: 0, y: 0, alt: 0, vAlt: 0, acc: 0, vx: 0, vy: 0, pitch: 0, roll: 0, yaw: 0, phase: 'PAD' });
    }
    return { frames, events: [], params: p, warnings };
  }

  const bodyCdA = (p.cd * Math.PI * p.diameter * p.diameter) / 4;
  const wx = p.windSpeed * Math.sin(rad(p.windDir));
  const wy = p.windSpeed * Math.cos(rad(p.windDir));

  let t = 0, alt = 0, v = 0, x = 0, y = 0, vx = 0, vy = 0, roll = 0;
  let apogeeT = null, drogueT = null, mainT = null;
  const events = [{ name: 'liftoff', t: 0 }];
  let burnoutDone = false;
  const frames = [];
  let step = 0;

  for (;;) {
    // --- event / phase bookkeeping at the current state
    if (!burnoutDone && t >= p.burnTime) {
      burnoutDone = true;
      events.push({ name: 'burnout', t: p.burnTime });
    }
    if (apogeeT === null && t >= p.burnTime && v <= 0) {
      apogeeT = t;
      events.push({ name: 'apogee', t });
    }
    if (apogeeT !== null && drogueT === null && (p.drogueDeployAlt <= 0 || alt <= p.drogueDeployAlt)) {
      drogueT = t;
      events.push({ name: 'drogue', t });
    }
    if (apogeeT !== null && mainT === null && v < 0 && alt <= p.mainDeployAlt) {
      mainT = t;
      events.push({ name: 'main', t });
    }
    let phase;
    let tp;
    if (mainT !== null) { phase = 'MAIN'; tp = t - mainT; }
    else if (drogueT !== null) { phase = 'DROGUE'; tp = t - drogueT; }
    else if (apogeeT !== null) { phase = 'DESCENT'; tp = t - apogeeT; }
    else if (t < p.burnTime) { phase = 'BOOST'; tp = t; }
    else { phase = 'COAST'; tp = t - p.burnTime; }

    // --- forces
    const ramp = (t0) => (t0 === null ? 0 : Math.min(1, (t - t0) / 0.5));
    const cda = bodyCdA + p.drogueCdA * ramp(drogueT) + p.mainCdA * ramp(mainT);
    const thrustAcc = t < p.burnTime ? p.thrust / p.mass : 0;
    const dragAcc = (-0.5 * airDensity(alt) * cda * v * Math.abs(v)) / p.mass;
    const a = thrustAcc + dragAcc - G;

    const att = attitude(phase, tp, p.burnTime);
    if (step % STRIDE === 0) {
      frames.push({
        t: +t.toFixed(6), x, y, alt: Math.max(alt, 0), vAlt: v, acc: a, vx, vy,
        pitch: att.pitch, roll, yaw: att.yaw, phase,
      });
    }

    if (t >= T_MAX) {
      warnings.push('Simulation stopped after 900 s without landing.');
      break;
    }

    // --- integrate (semi-implicit Euler)
    v += a * SIM_DT;
    alt += v * SIM_DT;
    // horizontal: relax toward a phase-dependent fraction of the wind
    let k, tau;
    if (mainT !== null) { k = 1; tau = 2; }
    else if (drogueT !== null) { k = 1; tau = 3; }
    else { k = 0.1; tau = 5; }
    vx += ((wx * k - vx) / tau) * SIM_DT;
    vy += ((wy * k - vy) / tau) * SIM_DT;
    x += vx * SIM_DT;
    y += vy * SIM_DT;
    roll += att.rollRate * SIM_DT;
    t += SIM_DT;
    step++;

    if (apogeeT !== null && alt <= 0) {
      alt = 0;
      events.push({ name: 'landing', t: +t.toFixed(6) });
      frames.push({
        t: +t.toFixed(6), x, y, alt: 0, vAlt: 0, acc: 0, vx: 0, vy: 0,
        pitch: att.pitch, roll, yaw: att.yaw, phase: 'LANDED',
      });
      break;
    }
  }
  return { frames, events, params: p, warnings };
}

// Closed-form terminal velocity for a given drag area, handy for sanity checks and the UI hint.
export function terminalVelocity(mass, cdA, alt = 0) {
  return Math.sqrt((2 * mass * G) / (airDensity(alt) * cdA));
}
