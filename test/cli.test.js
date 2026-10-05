'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLines } from '../src/cli.js';

function run(script) {
  return runLines(script.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))));
}

test('CLI processes a full JSONL session end to end', () => {
  const script = [
    { id: 1, cmd: 'add_edge', u: 'dock', v: 'a1', cost: 4 },
    { id: 2, cmd: 'add_edge', u: 'a1', v: 'bench', cost: 4 },
    { id: 3, cmd: 'add_edge', u: 'dock', v: 'bench', cost: 20 },
    { id: 4, cmd: 'query', from: 'dock', to: 'bench' },
    { id: 5, cmd: 'close', u: 'a1', v: 'bench' },
    { id: 6, cmd: 'query', from: 'dock', to: 'bench' },
    { id: 7, cmd: 'undo' },
    { id: 8, cmd: 'query', from: 'dock', to: 'bench' },
    { id: 9, cmd: 'set_cost', u: 'dock', v: 'bench', cost: 3 },
    { id: 10, cmd: 'query', from: 'dock', to: 'bench' },
    { id: 11, cmd: 'bogus' },
    'not json at all',
    { id: 12, cmd: 'add_edge', u: 'dock', v: 'a1', cost: 1 },
  ];
  const out = run(script);
  assert.equal(out.length, script.length);
  assert.deepEqual(out[0], { ok: true, version: 1, id: 1 });
  assert.equal(out[3].ok, true);
  assert.deepEqual(out[3].path, ['dock', 'a1', 'bench']);
  assert.equal(out[3].cost, 8);
  assert.equal(out[3].id, 4);
  // After closing a1-bench the direct (expensive) edge is the only route.
  assert.equal(out[5].cost, 20);
  assert.deepEqual(out[5].path, ['dock', 'bench']);
  // Undo reopens a1-bench.
  assert.equal(out[7].cost, 8);
  // Reweighted direct edge wins.
  assert.equal(out[9].cost, 3);
  assert.deepEqual(out[9].path, ['dock', 'bench']);
  // Errors.
  assert.equal(out[10].error, 'INVALID_INPUT');
  assert.equal(out[11].error, 'INVALID_INPUT');
  assert.equal(out[12].error, 'CONFLICT');
});

test('CLI verify accepts genuine certs and rejects forged ones', () => {
  const setup = [
    { cmd: 'add_edge', u: 'A', v: 'B', cost: 2 },
    { cmd: 'add_edge', u: 'B', v: 'C', cost: 2 },
    { cmd: 'query', from: 'A', to: 'C' },
  ];
  const first = run(setup);
  const cert = first[2].cert;
  assert.equal(first[2].cost, 4);

  // Genuine certificate verifies in a fresh identical session.
  const okRun = run([...setup.slice(0, 2), { cmd: 'verify', cert }]);
  assert.equal(okRun[2].ok, true);

  // Forged certificate fails.
  const forged = JSON.parse(JSON.stringify(cert));
  forged.cost = 1;
  const badRun = run([...setup.slice(0, 2), { cmd: 'verify', cert: forged }]);
  assert.equal(badRun[2].ok, false);
  assert.equal(badRun[2].error, 'CERT_INVALID');

  // Stale certificate (graph mutated after issuance) fails.
  const staleRun = run([
    ...setup,
    { cmd: 'set_cost', u: 'A', v: 'B', cost: 9 },
    { cmd: 'verify', cert },
  ]);
  assert.equal(staleRun[4].error, 'CERT_INVALID');
});
