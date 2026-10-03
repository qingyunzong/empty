'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { runRequest, main } = require('../src/cli');

const REQUEST = {
  config: { noiseThreshold: 2.0, calibQualityThreshold: 0.5 },
  state: {
    frames: [
      { frameId: 'f1', night: 'N1', instrument: 'camA', metrics: { noise: 1.0 } },
      { frameId: 'f2', night: 'N1', instrument: 'camA', metrics: { noise: 3.0 } },
    ],
    calibrations: [
      { kind: 'dark', night: 'N1', instrument: 'camA', version: 1, quality: 0.9 },
      { kind: 'flat', night: 'N1', instrument: 'camA', version: 1, quality: 0.9 },
    ],
    weather: [{ night: 'N1', state: 'clear' }],
  },
  transactions: [
    { id: 'txn-1', budget: 10, ops: [{ op: 'setWeather', night: 'N1', state: 'degraded' }] },
    { id: 'txn-2', budget: 1, ops: [{ op: 'setWeather', night: 'N1', state: 'blocked' }] },
  ],
};

// Spawning a child process is not permitted in this environment, so the
// stdin/stdout wiring of main() is exercised with injected streams.
function runMain(input) {
  return new Promise((resolve, reject) => {
    const stdin = Readable.from([input]);
    stdin.setEncoding = () => stdin;
    let out = '';
    let exitCode = 0;
    const stdout = { write: (chunk) => { out += chunk; return true; } };
    stdin.on('end', () => {
      setImmediate(() => {
        try {
          resolve({ code: exitCode, body: JSON.parse(out) });
        } catch (err) {
          reject(err);
        }
      });
    });
    main({ stdin, stdout, setExitCode: (code) => { exitCode = code; } });
  });
}

test('runRequest processes transactions and reports flags, queue and certificate', () => {
  const body = runRequest(REQUEST);
  assert.equal(body.results.length, 2);

  const first = body.results[0];
  assert.equal(first.ok, true);
  assert.equal(first.txnId, 'txn-1');
  assert.deepEqual(first.recomputeQueue, [
    { type: 'frame', night: 'N1', frameId: 'f1' },
    { type: 'frame', night: 'N1', frameId: 'f2' },
    { type: 'summary', night: 'N1' },
  ]);
  assert.deepEqual(first.flagDiffs, [{ night: 'N1', frameId: 'f1', before: 'usable', after: 'degraded' }]);
  assert.equal(first.certificate.txnId, 'txn-1');
  assert.equal(first.certificate.budget.used, 3);
  assert.match(first.certificate.digest, /^[0-9a-f]{64}$/);

  const second = body.results[1];
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'E_BUDGET');
});

test('cli main reads stdin and writes results to stdout', async () => {
  const { code, body } = await runMain(JSON.stringify(REQUEST));
  assert.equal(code, 0);
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].error.code, 'E_BUDGET');
});

test('cli main rejects malformed JSON with exit code 1', async () => {
  const { code, body } = await runMain('{not json');
  assert.equal(code, 1);
  assert.equal(body.error.code, 'E_INVALID');
});

test('cli main rejects invalid state with exit code 1', async () => {
  const { code, body } = await runMain(JSON.stringify({ state: { frames: [{ frameId: 'f1' }] }, transactions: [] }));
  assert.equal(code, 1);
  assert.equal(body.error.code, 'E_INVALID');
});
