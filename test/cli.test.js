import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

// The sandbox can drop piped stdio between processes, so the child reads
// its script from a file (--file) and writes its JSON output to a file.
function runCli(input) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  writeFileSync(inPath, typeof input === 'string' ? input : JSON.stringify(input));
  const outFd = openSync(outPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [cli, '--file', inPath], {
      stdio: ['ignore', outFd, 'inherit'],
      timeout: 60000,
    });
  } finally {
    closeSync(outFd);
  }
  const raw = readFileSync(outPath, 'utf8').trim();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

const script = {
  budgets: [{ material: 'steel', day: 1, amount: 100 }],
  orders: [
    { id: 'o1', plans: [
      [{ machine: 'm1', day: 1, material: 'steel', amount: 80 }],
      [{ machine: 'm2', day: 1, material: 'steel', amount: 80 }],
    ] },
  ],
};

test('CLI batch mode: exit 0, deterministic pick with certificate', () => {
  const { status, body } = runCli(script);
  assert.equal(status, 0);
  assert.equal(body.ok, true);
  const [result] = body.results;
  assert.deepEqual(result.plan, [{ machine: 'm1', day: 1, material: 'steel', amount: 80 }]);
  assert.equal(result.certificate.compared.length, 2);
});

test('CLI budget exhaustion across batch: exit 1 with E_BUDGET JSON', () => {
  const { status, body } = runCli({
    budgets: [{ material: 'steel', day: 1, amount: 100 }],
    orders: [
      { id: 'o1', plans: [[{ machine: 'm1', day: 1, material: 'steel', amount: 60 }]] },
      { id: 'o2', plans: [[{ machine: 'm2', day: 1, material: 'steel', amount: 60 }]] },
    ],
  });
  assert.equal(status, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_BUDGET');
});

test('CLI joint mode finds optimum; enumerate mode lists assignments', () => {
  const base = {
    budgets: [{ material: 'steel', day: 1, amount: 10 }],
    orders: [
      { id: 'o1', plans: [
        [{ machine: 'm1', day: 1, material: 'steel', amount: 6 }],
        [{ machine: 'm2', day: 1, material: 'steel', amount: 4 }],
      ] },
      { id: 'o2', plans: [
        [{ machine: 'm1', day: 1, material: 'steel', amount: 5 }],
        [{ machine: 'm2', day: 1, material: 'steel', amount: 4 }],
      ] },
    ],
  };
  const joint = runCli({ ...base, mode: 'joint' });
  assert.equal(joint.status, 0);
  assert.equal(joint.body.assignment.length, 2);

  const enumerated = runCli({ ...base, mode: 'enumerate' });
  assert.equal(enumerated.status, 0);
  assert.equal(enumerated.body.assignments.length, 3);
});

test('CLI joint mode with infeasible instance: exit 1 E_BUDGET', () => {
  const { status, body } = runCli({
    mode: 'joint',
    budgets: [{ material: 'steel', day: 1, amount: 5 }],
    orders: [{ id: 'o1', plans: [[{ machine: 'm1', day: 1, material: 'steel', amount: 6 }]] }],
  });
  assert.equal(status, 1);
  assert.equal(body.error.code, 'E_BUDGET');
});

test('CLI invalid JSON: exit 2 with E_PARSE', () => {
  const { status, body } = runCli('{not json');
  assert.equal(status, 2);
  assert.equal(body.error.code, 'E_PARSE');
});

test('CLI unknown mode: exit 2 with E_USAGE', () => {
  const { status, body } = runCli({ mode: 'nope', budgets: [], orders: [] });
  assert.equal(status, 2);
  assert.equal(body.error.code, 'E_USAGE');
});
