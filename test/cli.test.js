'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

// Note: this sandbox drops stdout of nested node processes when it is a pipe,
// so the CLI is exercised through file redirection instead.
function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-cli-'));
  const inFile = path.join(dir, 'req.json');
  const outFile = path.join(dir, 'out.json');
  fs.writeFileSync(inFile, typeof input === 'string' ? input : JSON.stringify(input));
  const proc = spawnSync('bash', ['-c', `"${process.execPath}" "${CLI}" < "${inFile}" > "${outFile}"`], {
    encoding: 'utf8',
  });
  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  return { status: proc.status, stdout, stderr: proc.stderr };
}

const REQ = {
  config: { threshold: 10 },
  state: {
    frames: [
      { id: 'f1', night: 'N1', instrument: 'camA', signal: 20 },
      { id: 'f2', night: 'N1', instrument: 'camA', signal: 4 },
    ],
    calibrations: { camA: { dark: 0, flat: 1 } },
    weather: { N1: { status: 'clear', attenuation: 1 } },
  },
  transactions: [
    { op: { type: 'setWeather', night: 'N1', status: 'blocked' }, budget: 10 },
    { op: { type: 'setWeather', night: 'N1', status: 'clear' }, budget: 10 },
    { op: { type: 'setCalibration', instrument: 'camA', dark: 6, flat: 1 }, budget: 1 },
  ],
};

test('cli processes transactions and reports diffs, queue, certificate', () => {
  const proc = runCli(REQ);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 3);

  const [blocked, cleared, overBudget] = out.results;
  assert.ok(blocked.ok);
  assert.deepEqual(
    blocked.diffs.filter((d) => d.layer === 'frame').map((d) => [d.frameId, d.from, d.to]),
    [
      ['f1', 'usable', 'blocked'],
      ['f2', 'degraded', 'blocked'],
    ]
  );
  assert.deepEqual(
    blocked.queue.map((q) => q.node),
    ['frame:f1', 'frame:f2', 'summary:N1']
  );
  assert.match(blocked.certificate, /^sha256:[0-9a-f]{64}$/);

  assert.ok(cleared.ok);
  assert.equal(cleared.diffs.find((d) => d.node === 'frame:f1').to, 'usable');

  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.error, 'E_BUDGET');
  assert.equal(overBudget.required, 3); // 2 frames + 1 summary
  assert.equal(overBudget.budget, 1);

  // E_BUDGET rolled back: flags reflect only the first two transactions.
  assert.deepEqual(out.final.flags, { f1: 'usable', f2: 'degraded' });
  assert.equal(out.final.summaries.N1.status, 'degraded');
  assert.equal(out.final.stateHash, cleared.stateHash);
});

test('cli rejects malformed input with E_INPUT', () => {
  const proc = runCli('{not json');
  assert.equal(proc.status, 1);
  const out = JSON.parse(proc.stdout);
  assert.deepEqual(out, { ok: false, error: 'E_INPUT' });
});

test('cli handles empty request', () => {
  const proc = runCli('{}');
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.final.flags, {});
  assert.deepEqual(out.final.summaries, {});
});
