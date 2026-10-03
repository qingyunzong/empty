import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, handleLine } from '../src/cliCore.js';

// Drives the exact CLI code path (NDJSON line -> JSON response) in-process.
function runCli(lines) {
  const handle = createHandler();
  return lines.map((l) => handleLine(handle, typeof l === 'string' ? l : JSON.stringify(l)));
}

const CURVE = { cmd: 'loadCurve', segments: [
  { from: 0, to: 2, coefs: [[1, 1], [2, 1]] },
  { from: 2, to: 4, coefs: [[0, 1], [0, 1], [1, 1]] },
] };

test('CLI: full command flow over NDJSON', () => {
  const res = runCli([
    CURVE,
    { cmd: 'post', day: 0, amountNum: 1, amountDen: 1 },
    { cmd: 'certify', from: 0, to: 4 },
    { cmd: 'backdate', day: 0, newAmount: { num: 2, den: 1 } },
    { cmd: 'certify', from: 0, to: 4 },
    { cmd: 'undoPost', id: 1 },
    { cmd: 'root' },
    { cmd: 'certify', from: 0, to: 9 },
  ]);
  assert.equal(res[0].ok, true);
  assert.deepEqual(res[1], { ok: true, id: 1 });
  const cert1 = res[2].cert;
  assert.equal(cert1.days[0].exact.n, '2');
  assert.equal(res[3].ok, true);
  const cert2 = res[4].cert;
  assert.equal(cert2.days[0].exact.n, '4', 'backdated amount doubles day 0 accrual');
  assert.notEqual(cert1.stateRoot, cert2.stateRoot);
  assert.equal(res[5].ok, true);
  assert.equal(res[6].ok, true);
  assert.equal(res[7].ok, false);
  assert.equal(res[7].error.code, 'E_PENDING');
});

test('CLI: verify round-trip and E_CERT after backdate', () => {
  const setup = [
    { cmd: 'loadCurve', segments: [{ from: 0, to: 3, coefs: [[1, 2]] }] },
    { cmd: 'post', day: 0, amountNum: 10, amountDen: 1 },
  ];
  const cert = runCli([...setup, { cmd: 'certify', from: 0, to: 3 }])[2].cert;
  const okRes = runCli([...setup, { cmd: 'verify', cert }]);
  assert.equal(okRes[2].ok, true);
  const badRes = runCli([...setup, { cmd: 'backdate', day: 0, newAmount: 20 }, { cmd: 'verify', cert }]);
  assert.equal(badRes[3].ok, false);
  assert.equal(badRes[3].error.code, 'E_CERT');
});

test('CLI: malformed input and unknown command yield JSON errors', () => {
  const res = runCli(['not json', JSON.stringify({ cmd: 'bogus' })]);
  assert.equal(res[0].ok, false);
  assert.equal(res[0].error.code, 'E_INTERNAL');
  assert.equal(res[1].ok, false);
  assert.equal(res[1].error.code, 'E_CMD');
});
