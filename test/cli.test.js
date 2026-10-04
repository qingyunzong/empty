import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { runRequest } from '../src/graph.js';

const REQUEST = {
  state: {
    nodes: [
      { id: 'a', kind: 'source', value: 1 },
      { id: 'b', kind: 'source', value: 2 },
      { id: 's', kind: 'derived', op: 'sum', inputs: ['a', 'b'] },
      { id: 'm', kind: 'derived', op: 'max', inputs: ['s'] },
    ],
  },
  transactions: [
    { id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 'a', value: 10 }] },
    { id: 't2', ops: [{ type: 'addEdge', from: 'm', to: 's' }] },
    { id: 't3', ops: [{ type: 'undo', tag: 'u1' }] },
  ],
};

test('CLI processes a request end to end', () => {
  const res = JSON.parse(runCli(JSON.stringify(REQUEST)));
  assert.equal(res.results.length, 3);
  assert.equal(res.results[0].status, 'ok');
  assert.deepEqual(res.results[0].affected, ['s', 'm']);
  assert.equal(res.results[1].status, 'error');
  assert.equal(res.results[1].error.code, 'E_CYCLE');
  assert.equal(res.results[2].status, 'ok');
  assert.equal(res.state.nodes.find((n) => n.id === 'a').value, 1, 'undo restored source');
  assert.equal(res.certificate.version, 2, 'failed tx does not bump version');
});

test('CLI output matches library runRequest', () => {
  assert.deepEqual(JSON.parse(runCli(JSON.stringify(REQUEST))), runRequest(REQUEST));
});

test('CLI reports E_INPUT on malformed JSON', () => {
  const res = JSON.parse(runCli('{not json'));
  assert.equal(res.error.code, 'E_INPUT');
});
