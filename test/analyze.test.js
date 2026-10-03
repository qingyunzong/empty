import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEvents, analyze, minimumCovers, ColdError } from '../index.js';

const MIN = 60000;

function run(raws, opts = {}) {
  const { events, late, watermark } = processEvents(raws, opts);
  return { result: analyze(events, { ...opts, watermark }), late, watermark };
}

test('acceptance 1: retracting an ok repair invalidates trusted readings and expands the recall', () => {
  const base = [
    { kind: 'repair', id: 'r0', eventTs: 0, sensor: 'S1', ok: false },
    { kind: 'repair', id: 'r1', eventTs: 5 * MIN, sensor: 'S1', ok: true },
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', sensor: 'S2', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 14 * MIN, zone: 'Z1', sensor: 'S1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 30 * MIN, zone: 'Z1', sensor: 'S2', c: 4 },
    { kind: 'temp', id: 't4', eventTs: 40 * MIN, zone: 'Z1', sensor: 'S2', c: 4 },
    { kind: 'door', id: 'd1', eventTs: 9 * MIN, zone: 'Z1', open: true },
    { kind: 'door', id: 'd2', eventTs: 15 * MIN, zone: 'Z1', open: false },
    { kind: 'ship', id: 's1', eventTs: 8 * MIN, lot: 'L1', zone: 'Z1', start: 9 * MIN, end: 21 * MIN },
  ];

  const before = run(base).result;
  assert.equal(before.unexplained.length, 0);
  assert.equal(before.explained.length, 1);
  assert.deepEqual(before.cover.solutions, [[]]);
  assert.equal(before.cover.minimumSize, 0);

  const after2 = run([...base, { kind: 'retract', eventTs: 40 * MIN, targetKind: 'repair', id: 'r1' }]).result;
  assert.equal(after2.unexplained.length, 1);
  const w = after2.unexplained[0];
  assert.equal(w.start, 10 * MIN);
  assert.equal(w.end, 30 * MIN);
  assert.deepEqual(after2.exposedLots, ['L1']);
  assert.deepEqual(after2.cover.solutions, [['L1']]);
  assert.equal(after2.cover.minimumSize, 1);
  assert.ok(after2.cover.minimumSize > before.cover.minimumSize);
});

test('acceptance 2: a short excursion overlapping a door opening is explained and avoids false recall', () => {
  const temps = [
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 13 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
  ];
  const ship = [{ kind: 'ship', id: 's1', eventTs: 8 * MIN, lot: 'L1', zone: 'Z1', start: 9 * MIN, end: 21 * MIN }];
  const door = [
    { kind: 'door', id: 'd1', eventTs: 9 * MIN, zone: 'Z1', open: true },
    { kind: 'door', id: 'd2', eventTs: 14 * MIN, zone: 'Z1', open: false },
  ];

  const withDoor = run([...temps, ...ship, ...door]).result;
  assert.equal(withDoor.unexplained.length, 0);
  assert.equal(withDoor.explained.length, 1);
  assert.deepEqual(withDoor.cover.solutions, [[]]);

  const noDoor = run([...temps, ...ship]).result;
  assert.equal(noDoor.unexplained.length, 1);
  assert.deepEqual(noDoor.cover.solutions, [['L1']]);
});

test('acceptance 3: enumerates all minimum covers with ties over 4 lots', () => {
  const raws = [
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 30 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't4', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't5', eventTs: 50 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't6', eventTs: 60 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't7', eventTs: 70 * MIN, zone: 'Z1', c: 4 },
    { kind: 'ship', id: 's1', eventTs: 0, lot: 'L1', zone: 'Z1', start: 5 * MIN, end: 25 * MIN },
    { kind: 'ship', id: 's2', eventTs: 0, lot: 'L2', zone: 'Z1', start: 5 * MIN, end: 45 * MIN },
    { kind: 'ship', id: 's3', eventTs: 0, lot: 'L3', zone: 'Z1', start: 25 * MIN, end: 65 * MIN },
    { kind: 'ship', id: 's4', eventTs: 0, lot: 'L4', zone: 'Z1', start: 45 * MIN, end: 65 * MIN },
  ];
  const { result } = run(raws);
  assert.equal(result.unexplained.length, 3);
  assert.equal(result.cover.minimumSize, 2);
  assert.deepEqual(result.cover.solutions, [['L1', 'L3'], ['L2', 'L3'], ['L2', 'L4']]);
});

test('acceptance 4: no excursions yields an empty recall set, not an error', () => {
  const { result } = run([
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 5 },
    { kind: 'ship', id: 's1', eventTs: 0, lot: 'L1', zone: 'Z1', start: 0, end: 30 * MIN },
  ]);
  assert.equal(result.unexplained.length, 0);
  assert.equal(result.cover.minimumSize, 0);
  assert.deepEqual(result.cover.solutions, [[]]);
  assert.deepEqual(result.exposedLots, []);
});

test('temp outside physical range throws TEMP_RANGE', () => {
  assert.throws(
    () => processEvents([{ kind: 'temp', id: 't1', eventTs: 0, zone: 'Z1', c: 150 }]),
    (err) => err instanceof ColdError && err.code === 'TEMP_RANGE',
  );
  assert.throws(
    () => processEvents([{ kind: 'temp', id: 't2', eventTs: 0, zone: 'Z1', c: -150 }]),
    (err) => err.code === 'TEMP_RANGE',
  );
});

test('ship window touching excursion endpoints does not count as exposure', () => {
  const { result } = run([
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'ship', id: 'sa', eventTs: 0, lot: 'LA', zone: 'Z1', start: 20 * MIN, end: 30 * MIN },
    { kind: 'ship', id: 'sb', eventTs: 0, lot: 'LB', zone: 'Z1', start: 0, end: 10 * MIN },
    { kind: 'ship', id: 'sc', eventTs: 0, lot: 'LC', zone: 'Z1', start: 19 * MIN, end: 21 * MIN },
  ]);
  assert.equal(result.unexplained.length, 1);
  assert.deepEqual(result.unexplained[0].exposedLots, ['LC']);
  assert.deepEqual(result.cover.solutions, [['LC']]);
});

test('retracting a ship removes it from recall and evidence', () => {
  const base = [
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'ship', id: 's1', eventTs: 0, lot: 'L1', zone: 'Z1', start: 9 * MIN, end: 21 * MIN },
  ];
  const before = run(base).result;
  assert.deepEqual(before.cover.solutions, [['L1']]);
  assert.equal(before.exposures.length, 1);

  const after = run([...base, { kind: 'retract', eventTs: 40 * MIN, targetKind: 'ship', id: 's1' }]).result;
  assert.equal(after.unexplained.length, 1);
  assert.deepEqual(after.unexplained[0].exposedLots, []);
  assert.equal(after.exposures.length, 0);
  assert.deepEqual(after.exposedLots, []);
  assert.deepEqual(after.cover.solutions, []);
  assert.equal(after.cover.minimumSize, null);
});

test('late events are logged against the watermark but still processed', () => {
  const { late, watermark, result } = run([
    { kind: 'temp', id: 't1', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't2', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't3', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
  ]);
  assert.equal(watermark, 38 * MIN);
  assert.equal(late.length, 2);
  assert.ok(late.some((l) => l.includes('t2')));
  assert.ok(late.some((l) => l.includes('t3')));
  assert.equal(result.unexplained.length, 1);
});

test('minimumCovers handles empty universe and infeasible cases', () => {
  assert.deepEqual(minimumCovers(0, new Map()), { minimumSize: 0, solutions: [[]] });
  const cov = new Map([['A', new Set([0])]]);
  assert.deepEqual(minimumCovers(2, cov), { minimumSize: null, solutions: [] });
  const cov2 = new Map([['A', new Set([0])], ['B', new Set([0, 1])]]);
  assert.deepEqual(minimumCovers(2, cov2), { minimumSize: 1, solutions: [['B']] });
});
