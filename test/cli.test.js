'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('../cli');

const script = [
  {
    cmd: 'invoice', id: 'inv-1', vars: ['amount', 'tax'],
    constraints: [
      { coefs: [1, 0], op: '>=', rhsNum: 10000, rhsDen: 1 },
      { coefs: [0, 1], op: '>=', rhsNum: 1300, rhsDen: 1 },
      { coefs: [-13, 100], op: '==', rhsNum: 0, rhsDen: 1 },
    ],
  },
  {
    cmd: 'credit', id: 'cr-1', refId: 'inv-1',
    constraints: [
      { coefs: [1, 0], op: '<=', rhsNum: 10000, rhsDen: 1 },
      { coefs: [0, 1], op: '<=', rhsNum: 1300, rhsDen: 1 },
      { coefs: [-13, 100], op: '==', rhsNum: 0, rhsDen: 1 },
    ],
  },
  { cmd: 'check', invoiceId: 'inv-1' },
  { cmd: 'voidCredit', id: 'cr-1' },
  {
    cmd: 'credit', id: 'cr-2', refId: 'inv-1',
    constraints: [
      { coefs: [1, 0], op: '<=', rhsNum: 9999, rhsDen: 1 },
      { coefs: [0, 1], op: '<=', rhsNum: 1300, rhsDen: 1 },
      { coefs: [-13, 100], op: '==', rhsNum: 0, rhsDen: 1 },
    ],
  },
  { cmd: 'check', invoiceId: 'inv-1' },
  { cmd: 'voidCredit', id: 'cr-2' },
];

test('CLI runs a full red-flush session end to end', () => {
  const results = JSON.parse(runCli(JSON.stringify({ commands: script })));
  assert.equal(results[2].status, 'SAT');
  assert.deepEqual(results[2].vertex, { amount: '10000', tax: '1300' });
  assert.equal(results[3].status, 'OK'); // unreferenced credit voids fine
  assert.equal(results[5].status, 'UNSAT');
  assert.equal(results[5].error, 'E_UNSAT');
  assert.ok(results[5].violated.length >= 2);
  assert.ok(results[5].violated.some((id) => id.startsWith('cr-2#')));
  assert.ok(results[5].violated.some((id) => id.startsWith('inv-1#')));
  assert.ok(Array.isArray(results[5].certificate.multipliers));
  assert.equal(results[6].error, 'E_PINNED'); // referenced by the certificate
});

test('CLI rejects malformed input', () => {
  assert.throws(() => runCli('{"nope": 1}'));
  assert.throws(() => runCli('not json'));
});
