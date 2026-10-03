import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const workdir = mkdtempSync(join(tmpdir(), 'recon-cli-'));
let invocation = 0;

// The sandbox blocks piped stdio for grandchild processes, so stdout/stderr
// are captured through file redirection instead of pipes.
function runCli(args) {
  invocation += 1;
  const outFile = join(workdir, `out-${invocation}.txt`);
  const errFile = join(workdir, `err-${invocation}.txt`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  try {
    const proc = spawnSync(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    if (proc.error) throw proc.error;
    return {
      status: proc.status,
      stdout: readFileSync(outFile, 'utf8'),
      stderr: readFileSync(errFile, 'utf8'),
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

function writeRecon(name, doc) {
  const file = join(workdir, name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

const normal = (entryId, amount, account = 'A') => ({ entryId, account, amount, type: 'normal' });
const reversal = (entryId, reversalOf, amount, account = 'A') => ({
  entryId, account, amount, type: 'reversal', reversalOf,
});

test('minimize prints certificate, minimal subsets and replay hash', () => {
  const file = writeRecon('unbalanced.json', {
    expected: [normal('E1', 100), normal('E2', 50)],
    actual: [normal('E2', 50), reversal('R1', 'E1', 100)],
  });
  const proc = runCli(['minimize', file]);
  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.status, 'UNBALANCED');
  assert.equal(output.certificate.algorithm, 'exhaustive-lexicographic');
  assert.equal(output.certificate.cardinalityMinimal, true);
  assert.equal(output.certificate.lexicographicallyMinimal, true);
  assert.deepEqual(output.minimal.expected.map((e) => e.entryId), ['E1']);
  assert.deepEqual(output.minimal.actual.map((e) => e.entryId), ['R1']);
  assert.match(output.replayHash, /^sha256:[0-9a-f]{64}$/);
});

test('balanced input returns a balance certificate', () => {
  const file = writeRecon('balanced.json', {
    expected: [normal('E1', 100)],
    actual: [normal('E1', 100)],
  });
  const proc = runCli(['minimize', file]);
  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.status, 'BALANCED');
  assert.equal(output.certificate.balanced, true);
  assert.deepEqual(output.differences, []);
});

test('output is deterministic across runs', () => {
  const file = writeRecon('det.json', {
    expected: [normal('E1', 100)],
    actual: [reversal('R1', 'E1', 100)],
  });
  const first = runCli(['minimize', file]);
  const second = runCli(['minimize', file]);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout);
});

test('invalid inputs exit 1 with INVALID_RECON', () => {
  const cases = {
    'negative.json': { expected: [normal('E1', -1)], actual: [] },
    'duplicate.json': { expected: [normal('E1', 1), normal('E1', 2)], actual: [] },
    'chain.json': { expected: [], actual: [reversal('R1', 'E1', 5), reversal('R2', 'R1', 5)] },
    'self.json': { expected: [], actual: [reversal('R1', 'R1', 5)] },
  };
  for (const [name, doc] of Object.entries(cases)) {
    const proc = runCli(['minimize', writeRecon(name, doc)]);
    assert.equal(proc.status, 1, `${name}: ${proc.stdout}${proc.stderr}`);
    assert.match(proc.stderr, /INVALID_RECON/, name);
  }
});

test('unreadable or malformed file exits 1 with INVALID_RECON', () => {
  const missing = runCli(['minimize', join(workdir, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /INVALID_RECON/);
  const garbage = join(workdir, 'garbage.json');
  writeFileSync(garbage, 'not json');
  const proc = runCli(['minimize', garbage]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /INVALID_RECON/);
});

test('usage errors exit 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['minimize']).status, 2);
  assert.equal(runCli(['bogus', 'x.json']).status, 2);
});
