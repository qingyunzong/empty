import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli-main.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'mold-sched-'));

function writeJson(name, value) {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

const io = {
  readFile: (p) => readFileSync(p, 'utf8'),
  readStdin: () => { throw new Error('stdin not expected'); },
};

const good = {
  jobs: [
    { id: 'j1', due: 6, work: 2, energy: 3, mold: 'A' },
    { id: 'j2', due: 9, work: 3, energy: 4, mold: 'B' },
  ],
  setup: { A: { B: 1 }, B: { A: 2 } },
  energyBudget: 20,
};

test('valid instance: exit 0 and FEASIBLE JSON on stdout', () => {
  const r = runCli([writeJson('good.json', good)], io);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'FEASIBLE');
  assert.deepEqual(Object.keys(out.objective), ['makespan', 'energy', 'tardiness']);
  assert.equal(out.schedule.length, 2);
  assert.equal(out.ties >= 1, true);
});

test('UNSAT instance: exit 0 with certificate', () => {
  const r = runCli([writeJson('unsat.json', { ...good, energyBudget: 1 })], io);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'UNSAT');
  assert.equal(out.certificate.type, 'unsat-certificate');
});

test('illegal setup: ERR_SCHEMA on stderr and exit code 2', () => {
  const cases = {
    'missing-mold-row.json': { ...good, setup: { A: { B: 1 } } },
    'missing-entry.json': { ...good, setup: { A: {}, B: { A: 2 } } },
    'negative-setup.json': { ...good, setup: { A: { B: -1 }, B: { A: 2 } } },
    'non-numeric-setup.json': { ...good, setup: { A: { B: 'x' }, B: { A: 2 } } },
    'setup-not-object.json': { ...good, setup: [1, 2] },
  };
  for (const [name, instance] of Object.entries(cases)) {
    const r = runCli([writeJson(name, instance)], io);
    assert.equal(r.code, 2, `${name}: expected exit 2, got ${r.code} (${r.stdout})`);
    assert.match(r.stderr, /ERR_SCHEMA/, `${name}: stderr should contain ERR_SCHEMA`);
  }
});

test('malformed JSON and missing file also exit 2', () => {
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, '{not json');
  const r1 = runCli([bad], io);
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /ERR_SCHEMA/);
  const r2 = runCli([join(tmp, 'does-not-exist.json')], io);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /ERR_INPUT/);
});

test('reads instance from stdin when path is -', () => {
  const r = runCli(['-'], { ...io, readStdin: () => JSON.stringify(good) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'FEASIBLE');
});

test('real process: illegal setup exits with code 2 and ERR_SCHEMA', (t) => {
  const probe = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'EPERM') {
    t.skip('sandbox forbids spawning child processes');
    return;
  }
  const r = spawnSync(process.execPath, [cli, writeJson('bad-setup.json', { ...good, setup: { A: {} } })], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERR_SCHEMA/);
  const ok = spawnSync(process.execPath, [cli, writeJson('good2.json', good)], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).status, 'FEASIBLE');
});
