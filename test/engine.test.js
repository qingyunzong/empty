import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, buildWaitEdges } from '../src/engine.js';
import { AgvError } from '../src/errors.js';

const WINDOW = 10_000;

// Three-vehicle ring:
//   B holds E1, A wants E1  -> A waits for B
//   C holds E2, B wants E2  -> B waits for C
//   A holds E3, C wants E3  -> C waits for A
function ringEvents() {
  return [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E3', id: 'R1' },
    { op: 'ping', eventTs: 100, agv: 'A', node: 'N3', speed: 0.2, id: 'P1' },
    { op: 'reserve', eventTs: 0, agv: 'B', edge: 'E1', id: 'R2' },
    { op: 'ping', eventTs: 100, agv: 'B', node: 'N1', speed: 0.1, id: 'P2' },
    { op: 'reserve', eventTs: 0, agv: 'C', edge: 'E2', id: 'R3' },
    { op: 'ping', eventTs: 100, agv: 'C', node: 'N2', speed: 0.3, id: 'P3' },
    { op: 'reserve', eventTs: 1000, agv: 'A', edge: 'E1', id: 'R4' },
    { op: 'reserve', eventTs: 1000, agv: 'B', edge: 'E2', id: 'R5' },
    { op: 'reserve', eventTs: 1000, agv: 'C', edge: 'E3', id: 'R6' },
  ];
}

test('acceptance 1: three-vehicle ring detected, then dissolved by a late cancel', () => {
  const events = [
    ...ringEvents(),
    // Push the watermark far forward...
    { op: 'ping', eventTs: 100_000, agv: 'A', node: 'N9', speed: 1.0, id: 'P9' },
    // ...so this cancel (eventTs 1000) arrives late but is still applied.
    { op: 'cancel', eventTs: 1000, reserveId: 'R4' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });

  // The cycle existed and was broken by the cancel: nothing active remains.
  assert.equal(result.cycles.length, 0);

  // Exactly one invalidated certificate, preserving the original hash.
  assert.equal(result.invalidated.length, 1);
  const inv = result.invalidated[0];
  assert.equal(inv.status, 'invalidated');
  assert.match(inv.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(inv.cycle, ['A', 'B', 'C']);
  assert.equal(inv.invalidatedBy.op, 'cancel');
  assert.equal(inv.invalidatedBy.id, 'R4');
  assert.equal(inv.edges.length, 3);

  // The cancel is recorded as late (watermark = 100000 - 2000 = 98000).
  assert.equal(result.late.length, 1);
  assert.equal(result.late[0].op, 'cancel');
  assert.equal(result.late[0].watermark, 98_000);

  // Remaining wait edges: B->C and C->A (A->B removed with R4).
  const pairs = result.waits.map((w) => `${w.from}->${w.to}`).sort();
  assert.deepEqual(pairs, ['B->C', 'C->A']);
});

test('ring certificate is stable while the ring persists', () => {
  const result = runEngine(ringEvents(), { windowMs: WINDOW });
  assert.equal(result.cycles.length, 1);
  const cert = result.cycles[0];
  assert.deepEqual(cert.cycle, ['A', 'B', 'C']);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  // Every edge of the cycle carries evidence event ids.
  for (const edge of cert.edges) {
    assert.ok(edge.waiterReserveId);
    assert.ok(edge.holderReserveId);
    assert.ok(edge.pingId);
    assert.ok(edge.overlapStart < edge.overlapEnd);
  }
  // Reproducible: identical input yields identical hash.
  const again = runEngine(ringEvents(), { windowMs: WINDOW });
  assert.equal(again.cycles[0].hash, cert.hash);
});

test('acceptance 2: intervals touching exactly at an endpoint do not create a wait', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    { op: 'ping', eventTs: 100, agv: 'A', node: 'N1', speed: 0.5, id: 'P1' },
    // B's window starts exactly where A's window ends: [0,10000) vs [10000,20000).
    { op: 'reserve', eventTs: 10_000, agv: 'B', edge: 'E1', id: 'R2' },
    { op: 'ping', eventTs: 10_100, agv: 'B', node: 'N1', speed: 0.5, id: 'P2' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });
  assert.equal(result.waits.length, 0);
  assert.equal(result.cycles.length, 0);
});

test('one millisecond of real overlap does create a wait', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    { op: 'ping', eventTs: 100, agv: 'A', node: 'N1', speed: 0.5, id: 'P1' },
    { op: 'reserve', eventTs: 9_999, agv: 'B', edge: 'E1', id: 'R2' },
    { op: 'ping', eventTs: 10_000, agv: 'B', node: 'N1', speed: 0.5, id: 'P2' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });
  assert.equal(result.waits.length, 1);
  assert.equal(result.waits[0].from, 'B');
  assert.equal(result.waits[0].to, 'A');
  assert.equal(result.waits[0].overlapStart, 9_999);
  assert.equal(result.waits[0].overlapEnd, 10_000);
});

test('acceptance 4: duplicate reserveId raises DUP_RESERVE', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    { op: 'reserve', eventTs: 5, agv: 'B', edge: 'E2', id: 'R1' },
  ];
  assert.throws(() => runEngine(events), (err) => {
    assert.ok(err instanceof AgvError);
    assert.equal(err.code, 'DUP_RESERVE');
    return true;
  });
});

test('duplicate reserveId is rejected even after the first was canceled', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    { op: 'cancel', eventTs: 10, reserveId: 'R1' },
    { op: 'reserve', eventTs: 20, agv: 'B', edge: 'E2', id: 'R1' },
  ];
  assert.throws(() => runEngine(events), { code: 'DUP_RESERVE' });
});

test('ping referencing an unknown agv raises UNKNOWN_AGV', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    { op: 'ping', eventTs: 100, agv: 'GHOST', node: 'N1', speed: 0.5, id: 'P1' },
  ];
  assert.throws(() => runEngine(events), { code: 'UNKNOWN_AGV' });
});

test('retract of a ping removes occupancy evidence and invalidates the cycle', () => {
  const events = [
    ...ringEvents(),
    { op: 'retract', eventTs: 2000, kind: 'ping', id: 'P2' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });
  assert.equal(result.cycles.length, 0);
  assert.equal(result.invalidated.length, 1);
  assert.equal(result.invalidated[0].invalidatedBy.op, 'retract');
  // B's occupancy of E1 is no longer confirmed, so A->B disappears.
  const pairs = result.waits.map((w) => `${w.from}->${w.to}`).sort();
  assert.deepEqual(pairs, ['B->C', 'C->A']);
});

test('retract of a reserve removes its wait edges', () => {
  const events = [
    ...ringEvents(),
    { op: 'retract', eventTs: 2000, kind: 'reserve', id: 'R6' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });
  assert.equal(result.cycles.length, 0);
  assert.equal(result.invalidated.length, 1);
  const pairs = result.waits.map((w) => `${w.from}->${w.to}`).sort();
  assert.deepEqual(pairs, ['A->B', 'B->C']);
});

test('unconfirmed reserve (no ping in window) does not hold an edge', () => {
  const events = [
    { op: 'reserve', eventTs: 0, agv: 'A', edge: 'E1', id: 'R1' },
    // Ping falls outside [0, 10000): no real occupancy.
    { op: 'ping', eventTs: 20_000, agv: 'A', node: 'N1', speed: 0.5, id: 'P1' },
    { op: 'reserve', eventTs: 100, agv: 'B', edge: 'E1', id: 'R2' },
  ];
  const result = runEngine(events, { windowMs: WINDOW });
  assert.equal(result.waits.length, 0);
});

test('buildWaitEdges is deterministic regardless of reserve array order', () => {
  const reserves = [
    { id: 'R1', agv: 'A', edge: 'E1', eventTs: 0 },
    { id: 'R2', agv: 'B', edge: 'E1', eventTs: 500 },
    { id: 'R3', agv: 'C', edge: 'E1', eventTs: 900 },
  ];
  const pings = [
    { id: 'P1', agv: 'A', eventTs: 10 },
    { id: 'P2', agv: 'B', eventTs: 510 },
  ];
  const a = buildWaitEdges(reserves, pings, WINDOW);
  const b = buildWaitEdges([...reserves].reverse(), [...pings].reverse(), WINDOW);
  assert.deepEqual(a, b);
});
