'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../cli.js');

function runCli(input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const { status, output } = main(payload);
  return { status, stdout: output, json: JSON.parse(output) };
}

test('CLI reads JSON from stdin and reports events, diffs and certificate', () => {
  const { status, json } = runCli({
    finalizeHorizon: 2,
    observations: [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
      { ts: 3, value: 30 },
      { ts: 4, value: 40 },
    ],
    nodes: [
      { id: 'm2', type: 'mean', window: 2 },
      { id: 'v2', type: 'variance', window: 2 },
    ],
    ops: [
      { cmd: 'correct', op: 'offset', ts: 3, value: 6, reason: 'sensor drift', cts: 1 },
      { cmd: 'correct', corrections: [
        { op: 'set', ts: 4, value: 44, reason: 'late b', cts: 3 },
        { op: 'scale', ts: 2, value: 2, reason: 'late a', cts: 2 },
      ] },
      { cmd: 'setWindow', node: 'm2', window: 3 },
      { cmd: 'undo' },
      { cmd: 'redo' },
      { cmd: 'correct', op: 'set', ts: 1, value: 0, reason: 'finalized', cts: 4 },
      { cmd: 'correct', op: 'set', ts: 99, value: 0, reason: 'nowhere', cts: 5 },
    ],
  });

  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.events.length, 4 + 2 + 7);

  const correct1 = json.events[6];
  assert.equal(correct1.cmd, 'correct');
  assert.equal(correct1.ok, true);
  assert.ok(correct1.diffs.length > 0);
  assert.ok(correct1.affected.startTs <= correct1.affected.endTs);
  assert.match(correct1.certificate, /^[0-9a-f]{64}$/);

  const batch = json.events[7];
  assert.equal(batch.ok, true);
  assert.equal(batch.applied, 2);

  const finalized = json.events[11];
  assert.equal(finalized.ok, false);
  assert.equal(finalized.error, 'E_FINALIZED');

  const outOfRange = json.events[12];
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error, 'E_RANGE');

  const state = json.state;
  assert.deepEqual(state.observations.map((o) => o.value), [10, 40, 36, 44]);
  assert.deepEqual(state.log.map((e) => e.cts), [1, 2, 3]);
  assert.equal(state.nodes.find((n) => n.id === 'm2').window, 3);
  assert.deepEqual(state.nodes.find((n) => n.id === 'm2').outputs, [null, null, 86 / 3, 40]);
  assert.match(state.certificate, /^[0-9a-f]{64}$/);
});

test('CLI is deterministic across runs', () => {
  const spec = {
    observations: [{ ts: 1, value: 5 }, { ts: 2, value: 7 }],
    nodes: [{ id: 'm2', type: 'mean', window: 2 }],
    corrections: [{ op: 'offset', ts: 2, value: 1, reason: 'r', cts: 1 }],
  };
  const a = runCli(spec);
  const b = runCli(spec);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.json.state.certificate, b.json.state.certificate);
});

test('CLI handles empty input, empty sequence and invalid JSON stably', () => {
  const empty = runCli('');
  assert.equal(empty.status, 0);
  assert.equal(empty.json.ok, true);
  assert.deepEqual(empty.json.state.observations, []);
  assert.match(empty.json.state.certificate, /^[0-9a-f]{64}$/);

  const emptySeq = runCli({
    nodes: [{ id: 'm2', type: 'mean', window: 2 }],
    ops: [
      { cmd: 'correct', op: 'set', ts: 1, value: 1, reason: 'x', cts: 1 },
      { cmd: 'undo' },
    ],
  });
  assert.equal(emptySeq.status, 0);
  assert.equal(emptySeq.json.events[1].error, 'E_RANGE');
  assert.equal(emptySeq.json.events[2].error, 'E_UNDO_EMPTY');
  assert.deepEqual(emptySeq.json.state.nodes[0].outputs, []);

  const bad = runCli('{not json');
  assert.equal(bad.status, 1);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.error, 'E_PARSE');
});
