import test from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, chartTimeAt, CHARTS } from '../src/graph.js';

test('niceTicks produces round, in-range ticks', () => {
  const { step, ticks } = niceTicks(0, 1077, 4);
  assert.equal(step, 200);
  assert.deepEqual(ticks, [0, 200, 400, 600, 800, 1000]);
  const n = niceTicks(-3.2, 4.1, 4);
  assert.ok(n.ticks.every((t) => t >= -3.2 && t <= 4.1));
  assert.ok(niceTicks(5, 5, 4).ticks.length >= 1);
});

test('chartTimeAt clamps to the time range', () => {
  assert.equal(chartTimeAt(-50, 400, 0, 100), 0);
  assert.equal(chartTimeAt(10000, 400, 0, 100), 100);
  assert.ok(Math.abs(chartTimeAt(46 + (400 - 54) / 2, 400, 0, 100) - 50) < 1e-9);
});

test('three charts are defined: altitude, velocity, acceleration', () => {
  assert.deepEqual(CHARTS.map((c) => c.field), ['alt', 'vAlt', 'acc']);
});
