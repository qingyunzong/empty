import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/wip-count.js', import.meta.url));

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Grandchild stdio pipes are swallowed in this sandbox, so the CLI is run
// through bash with stdout/stderr redirected to files.
async function cli(args) {
  const runner = await makeDir();
  const outFile = path.join(runner, 'stdout');
  const errFile = path.join(runner, 'stderr');
  const codeFile = path.join(runner, 'code');
  const cmd =
    [process.execPath, CLI, ...args].map(shq).join(' ') +
    ` > ${shq(outFile)} 2> ${shq(errFile)}; echo $? > ${shq(codeFile)}`;
  const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(result.status, 0, `runner failed: ${result.stderr}`);
  return {
    code: Number(readFileSync(codeFile, 'utf8').trim()),
    stdout: readFileSync(outFile, 'utf8').trim(),
    stderr: readFileSync(errFile, 'utf8').trim(),
  };
}

function stderrJson(result) {
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.error && typeof parsed.error.code === 'string', 'stderr carries JSON error');
  return parsed.error;
}

test('happy path: begin -> scan -> close -> verify', async () => {
  const dir = await makeDir();
  let r = await cli(['begin', '--data', dir, '--session', 's1', '--node', 't1']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '3']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).session.totals, { 'A-01|WIP-0001': 3 });

  r = await cli(['close', '--data', dir, '--session', 's1']);
  assert.equal(r.code, 0);

  r = await cli(['verify', '--data', dir]);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.stock, { 'A-01|WIP-0001': 3 });
});

test('exit 2 with JSON stderr on validation and usage errors', async () => {
  const dir = await makeDir();
  await cli(['begin', '--data', dir, '--session', 's1', '--node', 't1']);

  let r = await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'bad', '--item', 'WIP-0001', '--qty', '1']);
  assert.equal(r.code, 2);
  assert.equal(stderrJson(r).code, 'VALIDATION');

  r = await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '1.5']);
  assert.equal(r.code, 2);
  assert.equal(stderrJson(r).code, 'VALIDATION');

  r = await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001']);
  assert.equal(r.code, 2);
  assert.equal(stderrJson(r).code, 'USAGE');

  r = await cli(['bogus']);
  assert.equal(r.code, 2);
  assert.equal(stderrJson(r).code, 'USAGE');
});

test('exit 3 with JSON stderr on state errors (CLOSED)', async () => {
  const dir = await makeDir();
  await cli(['begin', '--data', dir, '--session', 's1', '--node', 't1']);
  await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '1']);
  await cli(['close', '--data', dir, '--session', 's1']);

  const r = await cli(['scan', '--data', dir, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '1']);
  assert.equal(r.code, 3);
  assert.equal(stderrJson(r).code, 'CLOSED');

  const missing = await cli(['close', '--data', dir, '--session', 'nope']);
  assert.equal(missing.code, 3);
  assert.equal(stderrJson(missing).code, 'NOT_FOUND');
});

test('exit 10 on verify divergence, 0 after sync', async () => {
  const dirA = await makeDir();
  const dirB = await makeDir();
  await cli(['begin', '--data', dirA, '--session', 's1', '--node', 't1']);
  await cli(['scan', '--data', dirA, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '2']);
  await cli(['close', '--data', dirA, '--session', 's1']);
  await cli(['begin', '--data', dirB, '--session', 's1', '--node', 't2']);
  await cli(['scan', '--data', dirB, '--session', 's1', '--bin', 'A-01', '--item', 'WIP-0001', '--qty', '3']);
  await cli(['close', '--data', dirB, '--session', 's1']);

  let r = await cli(['verify', '--data', dirA, '--peer', dirB]);
  assert.equal(r.code, 10);
  assert.equal(JSON.parse(r.stdout).ok, false);

  r = await cli(['sync', '--data', dirA, '--peer', dirB]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).stock, { 'A-01|WIP-0001': 5 });

  r = await cli(['verify', '--data', dirA, '--peer', dirB]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).converged, true);
});

test('resume command reports recovery as JSON', async () => {
  const dir = await makeDir();
  await cli(['begin', '--data', dir, '--session', 's1', '--node', 't1']);
  const r = await cli(['resume', '--data', dir]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);
});
