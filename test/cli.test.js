import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
const example = (name) => join(ROOT, 'examples', name);

// Note: this sandbox drops piped stdout of nested node processes, so the
// child's stdout/stderr are captured through temp files instead of pipes.
const runCli = (args) => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-cli-'));
  const outPath = join(dir, 'stdout.txt');
  const errPath = join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: r.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
};

test('optimize --json writes a verifiable plan (exit 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-'));
  const planPath = join(dir, 'plan.json');
  const opt = runCli(['optimize', example('feasible.dsl'), '--json', planPath]);
  assert.equal(opt.status, 0, opt.stderr);
  assert.match(opt.stdout, /^OPTIMAL/);
  assert.ok(existsSync(planPath));
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.equal(plan.status, 'OPTIMAL');
  assert.equal(plan.total_mass_g, 200);
  assert.ok(plan.cost_micro_cny > 0);
  assert.ok(plan.margins.length >= 3);
  assert.match(plan.certificate, /^[0-9a-f]{64}$/);

  const ver = runCli(['verify', planPath]);
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /^OK: certificate [0-9a-f]{64}/);
});

test('INFEASIBLE exits 4 and is not confused with OVER_BUDGET', () => {
  const r = runCli(['optimize', example('infeasible.dsl')]);
  assert.equal(r.status, 4);
  assert.match(r.stdout, /"status": "INFEASIBLE"/);
});

test('OVER_BUDGET exits 3', () => {
  const r = runCli(['optimize', example('over_budget.dsl')]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /"status": "OVER_BUDGET"/);
});

test('diagnostics carry line:col and exit 2', () => {
  for (const [file, pattern] of [
    ['bad_dimension.dsl', /bad_dimension\.dsl:4:15: error: dimension mismatch/],
    ['macro_cycle.dsl', /macro_cycle\.dsl:3:14: error: circular macro expansion/],
    ['undeclared.dsl', /undeclared\.dsl:7:12: error: undeclared ingredient 'Ghost'/],
  ]) {
    const r = runCli(['optimize', example(file)]);
    assert.equal(r.status, 2, `${file}: ${r.stderr}`);
    assert.match(r.stderr, pattern);
  }
});

test('verify rejects a tampered plan (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-'));
  const planPath = join(dir, 'plan.json');
  assert.equal(runCli(['optimize', example('feasible.dsl'), '--json', planPath]).status, 0);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.recipe.Flour += 20;
  plan.recipe.Bran -= 20;
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const ver = runCli(['verify', planPath]);
  assert.equal(ver.status, 1);
  assert.match(ver.stderr, /verify failed:/);
});

test('verify rejects a forged certificate (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-'));
  const planPath = join(dir, 'plan.json');
  assert.equal(runCli(['optimize', example('feasible.dsl'), '--json', planPath]).status, 0);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.cost_micro_cny = 1; // lie about the cost, keep certificate stale
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const ver = runCli(['verify', planPath]);
  assert.equal(ver.status, 1);
  assert.match(ver.stderr, /certificate mismatch/);
});

test('usage errors exit 1', () => {
  assert.equal(runCli(['optimize']).status, 1);
  assert.equal(runCli(['verify']).status, 1);
  assert.equal(runCli(['frobnicate']).status, 1);
  assert.equal(runCli(['optimize', 'no/such/file.dsl']).status, 1);
});
