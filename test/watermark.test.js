import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, parseEvent } from '../src/engine.js';

const ev = (obj) => parseEvent(JSON.stringify(obj), 0);

test('watermark = max event time - 2s; only strictly earlier events are late', () => {
  const eng = new Engine();
  eng.ingest(ev({ type: 'reserve', id: 'r1', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' }));
  assert.equal(eng.late.length, 0);

  eng.ingest(ev({ type: 'reserve', id: 'r2', eventTs: 5000, agv: 'B', edge: 'n3->n4', op: 'start' }));
  assert.equal(eng.watermark, 3000);

  // Exactly at the watermark: not late.
  eng.ingest(ev({ type: 'ping', id: 'p1', eventTs: 3000, agv: 'A', node: 'n1', speed: 0, op: 'set' }));
  assert.equal(eng.late.length, 0);

  // One ms below the watermark: late.
  eng.ingest(ev({ type: 'ping', id: 'p2', eventTs: 2999, agv: 'B', node: 'n3', speed: 0, op: 'set' }));
  assert.equal(eng.late.length, 1);
  assert.match(eng.late[0], /type=ping/);
  assert.match(eng.late[0], /eventTs=2999/);
  assert.match(eng.late[0], /watermark=3000/);
});

test('event-time order, not arrival order, drives window pairing', () => {
  const eng = new Engine();
  // Reserve end arrives BEFORE its start in the file (out-of-order arrival),
  // but event-time pairing must still produce window [1000, 5000).
  eng.ingest(ev({ type: 'reserve', id: 'r1', eventTs: 5000, agv: 'A', edge: 'n1->n2', op: 'end' }));
  eng.ingest(ev({ type: 'reserve', id: 'r1', eventTs: 1000, agv: 'A', edge: 'n1->n2', op: 'start' }));
  eng.ingest(ev({ type: 'reserve', id: 'r2', eventTs: 0, agv: 'B', edge: 'n5->n6', op: 'start' }));
  eng.ingest(ev({ type: 'ping', id: 'p1', eventTs: 2000, agv: 'B', node: 'n1', speed: 0, op: 'set' }));
  eng.ingest(ev({ type: 'ping', id: 'p2', eventTs: 4000, agv: 'B', node: 'n1', speed: 1, op: 'set' }));
  // B stopped at n1 over [2000,4000); A's reserve window [1000,5000) -> wait [2000,4000).
  assert.equal(eng.waits.length, 1);
  assert.equal(eng.waits[0].from, 'A');
  assert.equal(eng.waits[0].to, 'B');
  assert.equal(eng.waits[0].start, 2000);
  assert.equal(eng.waits[0].end, 4000);
});
