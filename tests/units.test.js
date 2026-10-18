import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, toSI, factor, guessUnit, guessTimeUnitFromValues } from '../src/units.js';

test('length and time conversion', () => {
  assert.ok(Math.abs(toSI('length', 1000, 'ft') - 304.8) < 1e-9);
  assert.equal(toSI('time', 1500, 'ms'), 1.5);
  assert.equal(toSI('time', 2, 'min'), 120);
  assert.ok(Math.abs(convert('length', 1000, 'm', 'ft') - 3280.8399) < 1e-3);
  assert.ok(Math.abs(convert('velocity', 100, 'km/h', 'm/s') - 27.7778) < 1e-3);
  assert.ok(Math.abs(toSI('accel', 2, 'g') - 19.6133) < 1e-9);
});

test('round trip m -> ft -> m', () => {
  const v = 1234.5;
  assert.ok(Math.abs(convert('length', convert('length', v, 'm', 'ft'), 'ft', 'm') - v) < 1e-9);
});

test('unknown units throw', () => {
  assert.throws(() => factor('length', 'furlong'), /Unknown length unit/);
  assert.throws(() => factor('mass', 'kg'), /Unknown unit kind/);
});

test('guessUnit from headers', () => {
  assert.equal(guessUnit('length', 'Altitude (ft)'), 'ft');
  assert.equal(guessUnit('length', 'alt_feet'), 'ft');
  assert.equal(guessUnit('length', 'Height [m]'), 'm');
  assert.equal(guessUnit('length', 'altitude'), null);
  assert.equal(guessUnit('time', 'time_ms'), 'ms');
  assert.equal(guessUnit('time', 'Time (s)'), 's');
  assert.equal(guessUnit('velocity', 'Velocity (ft/s)'), 'ft/s');
  assert.equal(guessUnit('velocity', 'speed_mps'), 'm/s');
  assert.equal(guessUnit('accel', 'accel_g'), 'g');
});

test('guessTimeUnitFromValues', () => {
  assert.equal(guessTimeUnitFromValues([0, 20, 40, 60]), 'ms');
  assert.equal(guessTimeUnitFromValues([0, 0.02, 0.04, 0.06]), 's');
  assert.equal(guessTimeUnitFromValues([1]), 's');
});
