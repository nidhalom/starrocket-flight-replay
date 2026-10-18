// Unit tables (factor = multiply to get SI) and helpers. Pure, no DOM.

export const UNITS = {
  length: { m: 1, ft: 0.3048, km: 1000 },
  time: { s: 1, ms: 0.001, min: 60 },
  velocity: { 'm/s': 1, 'ft/s': 0.3048, 'km/h': 1 / 3.6, mph: 0.44704 },
  accel: { 'm/s2': 1, 'ft/s2': 0.3048, g: 9.80665 },
};

export const DEFAULT_UNIT = { length: 'm', time: 's', velocity: 'm/s', accel: 'm/s2' };

export function factor(kind, unit) {
  const table = UNITS[kind];
  if (!table) throw new Error(`Unknown unit kind: ${kind}`);
  const f = table[unit];
  if (f === undefined) throw new Error(`Unknown ${kind} unit: ${unit}`);
  return f;
}

export function toSI(kind, value, unit) {
  return value * factor(kind, unit);
}

export function convert(kind, value, from, to) {
  return (value * factor(kind, from)) / factor(kind, to);
}

function tokens(header) {
  return String(header)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Guess a unit from a column header such as "Altitude (ft)" or "time_ms".
// Returns null when the header carries no unit hint.
export function guessUnit(kind, header) {
  const tk = tokens(header);
  const has = (...names) => names.some((n) => tk.includes(n));
  switch (kind) {
    case 'length':
      if (has('ft', 'feet', 'foot')) return 'ft';
      if (has('km')) return 'km';
      if (has('m', 'meters', 'metres', 'meter', 'metre')) return 'm';
      return null;
    case 'time':
      if (has('ms', 'msec', 'millis', 'milliseconds', 'millisecond')) return 'ms';
      if (has('min', 'minutes')) return 'min';
      if (has('s', 'sec', 'secs', 'seconds')) return 's';
      return null;
    case 'velocity':
      if (has('mph')) return 'mph';
      if (has('fps') || has('ft')) return 'ft/s';
      if (has('kmh') || (has('km') && has('h'))) return 'km/h';
      if (has('mps') || has('m')) return 'm/s';
      return null;
    case 'accel':
      if (has('g', 'gs')) return 'g';
      if (has('ft')) return 'ft/s2';
      if (has('m', 'mps2')) return 'm/s2';
      return null;
    default:
      return null;
  }
}

// Median sample spacing heuristic for time columns without a unit hint:
// a median step of 5 or more is almost certainly milliseconds.
export function guessTimeUnitFromValues(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 3) return 's';
  const d = [];
  for (let i = 1; i < v.length; i++) {
    const s = v[i] - v[i - 1];
    if (s > 0) d.push(s);
  }
  if (!d.length) return 's';
  d.sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  return med >= 5 ? 'ms' : 's';
}
