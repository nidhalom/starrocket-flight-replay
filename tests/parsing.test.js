import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCSV, parseNumber, detectColumns, extractSeries, parseJSONInput } from '../src/csv.js';

test('parseNumber handles plain, decimal comma, quotes and junk', () => {
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber(' -3 '), -3);
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('"7.25"'), 7.25);
  assert.equal(parseNumber('1e3'), 1000);
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('abc')));
  assert.ok(Number.isNaN(parseNumber('0x10')));
});

test('parseCSV: comma, BOM, comments, header', () => {
  const p = parseCSV('﻿# note\nTime (s),Altitude (m)\n0,0\n1,10\n');
  assert.equal(p.delimiter, ',');
  assert.deepEqual(p.headers, ['Time (s)', 'Altitude (m)']);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.comments, ['note']);
});

test('parseCSV: semicolon with decimal commas', () => {
  const p = parseCSV('time;alt\n0,5;1,25\n1,0;2,5\n');
  assert.equal(p.delimiter, ';');
  const d = detectColumns(p.headers, p.rows);
  const s = extractSeries(p, d.mapping);
  assert.deepEqual(s.time, [0.5, 1]);
  assert.deepEqual(s.altitude, [1.25, 2.5]);
});

test('parseCSV: tab, whitespace and headerless input', () => {
  assert.equal(parseCSV('t\talt\n0\t0\n1\t5\n').delimiter, '\t');
  const ws = parseCSV('0 0\n1 5\n2 9\n');
  assert.equal(ws.delimiter, 'ws');
  assert.equal(ws.hasHeader, false);
  const d = detectColumns(ws.headers, ws.rows);
  assert.equal(d.mapping.time, 0);
  assert.equal(d.mapping.altitude, 1);
});

test('parseCSV: quoted fields containing the delimiter', () => {
  const p = parseCSV('time,note,alt\n0,"a, b",1\n1,"c",2\n');
  assert.equal(p.rows[0][1], 'a, b');
  assert.equal(p.rows[0].length, 3);
});

test('parseCSV: empty input throws', () => {
  assert.throws(() => parseCSV('# only comments\n\n'), /no data rows/);
});

test('detectColumns: aliases and unit hints from headers', () => {
  const p = parseCSV('Flight Time (ms),Baro Altitude AGL (ft),Velocity (ft/s),Accel (g),Latitude,Longitude,State\n0,0,0,1,10.1,20.2,PAD\n50,5,10,2,10.1,20.2,\n100,15,30,3,10.1,20.2,BOOST\n');
  const d = detectColumns(p.headers, p.rows);
  assert.deepEqual(d.mapping, { time: 0, altitude: 1, velocity: 2, acceleration: 3, lat: 4, lon: 5, event: 6 });
  assert.equal(d.units.time, 'ms');
  assert.equal(d.units.length, 'ft');
  assert.equal(d.units.velocity, 'ft/s');
  assert.equal(d.units.accel, 'g');
});

test('detectColumns: prefers barometric over GPS altitude, does not take velocity as altitude', () => {
  const p = parseCSV('time,gps_alt,baro_alt,vel\n0,1,0,0\n1,3,2,2\n2,9,8,6\n');
  const d = detectColumns(p.headers, p.rows);
  assert.equal(d.mapping.altitude, 2);
  assert.equal(d.mapping.velocity, 3);
});

test('detectColumns: time unit guessed from sample spacing when header has no hint', () => {
  const p = parseCSV('timestamp,height\n0,0\n50,1\n100,3\n150,6\n');
  assert.equal(detectColumns(p.headers, p.rows).units.time, 'ms');
  const q = parseCSV('timestamp,height\n0,0\n0.05,1\n0.1,3\n0.15,6\n');
  assert.equal(detectColumns(q.headers, q.rows).units.time, 's');
});

test('extractSeries: counts skipped rows and builds event labels on change', () => {
  const p = parseCSV('time,alt,event\n0,0,PAD\n1,x,\n2,5,BOOST\n3,9,BOOST\n');
  const d = detectColumns(p.headers, p.rows);
  const s = extractSeries(p, d.mapping);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.labels.map((l) => l.label), ['PAD', 'BOOST']);
});

test('extractSeries: missing mapping throws', () => {
  const p = parseCSV('a,b\n1,2\n3,4\n');
  assert.throws(() => extractSeries(p, { time: -1, altitude: 1 }), /time/i);
  assert.throws(() => extractSeries(p, { time: 0, altitude: -1 }), /altitude/i);
});

test('parseJSONInput: objects array, column object, nested samples, bad input', () => {
  const a = parseJSONInput('[{"time":0,"altitude":0},{"time":1,"altitude":5}]');
  assert.equal(a.type, 'table');
  assert.deepEqual(a.headers, ['time', 'altitude']);
  const b = parseJSONInput('{"time":[0,1,2],"altitude":[0,3,7]}');
  assert.equal(b.rows.length, 3);
  const c = parseJSONInput('{"samples":[{"t":0,"alt":0}]}');
  assert.equal(c.type, 'table');
  assert.throws(() => parseJSONInput('{"hello":1}'), /Unrecognised/);
  assert.throws(() => parseJSONInput('{nope'), /Invalid JSON/);
  assert.equal(parseJSONInput('{"format":"starrocket-flight"}').type, 'records');
});

test('sample CSVs parse and are labelled synthetic', () => {
  for (const f of ['synthetic-baro-only.csv', 'synthetic-gps-events.csv']) {
    const text = readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
    assert.match(text.split('\n')[0], /SYNTHETIC/);
    const p = parseCSV(text);
    const d = detectColumns(p.headers, p.rows);
    assert.ok(d.mapping.time >= 0 && d.mapping.altitude >= 0, f);
  }
});
