import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cli-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
// The sandbox swallows grandchild stdio pipes, so run the CLI through a
// shell with file redirection and read the captured streams back.
const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function run(args, cwd) {
  const out = join(cwd, '.cap-out'), err = join(cwd, '.cap-err'), code = join(cwd, '.cap-code');
  const cmd = [process.execPath, CLI, ...args].map(quote).join(' ')
    + ` >${quote(out)} 2>${quote(err)}; echo -n $? >${quote(code)}`;
  spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  return {
    status: Number(readFileSync(code, 'utf8')),
    stdout: readFileSync(out, 'utf8'),
    stderr: readFileSync(err, 'utf8'),
  };
}

const BASE = {
  'machines.jsonl': '{"id":"K1","rate":10}\n',
  'molds.jsonl': '{"id":"M1","machine":"K1"}\n{"id":"M2","machine":"K1"}\n',
  'operators.jsonl': '{"id":"P1"}\n{"id":"P2"}\n',
  'setups.jsonl': '{"from":"M1","to":"M2","minutes":2}\n{"from":"M2","to":"M1","minutes":2}\n',
};
const planArgs = (dir, d) => ['plan', '--dir', join(d, 'data'),
  '--orders', join(dir, 'orders.jsonl'), '--molds', join(dir, 'molds.jsonl'),
  '--machines', join(dir, 'machines.jsonl'), '--setups', join(dir, 'setups.jsonl'),
  '--operators', join(dir, 'operators.jsonl')];

test('invalid input -> exit 2 with {code, at} JSON on stderr', () => {
  const dir = setup({ ...BASE, 'orders.jsonl': '{"id":"O1","mold":"M1","operator":"P1","qty":10,"due":100}\n{bad json\n' });
  const r = run(planArgs(dir, dir), dir);
  assert.equal(r.status, 2, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, 'E_INPUT');
  assert.match(err.at, /orders\.jsonl:2/);
});

test('unknown reference is an input error (exit 2), never reported as infeasible', () => {
  const dir = setup({ ...BASE, 'orders.jsonl': '{"id":"O1","mold":"M9","operator":"P1","qty":10,"due":100}\n' });
  const r = run(planArgs(dir, dir), dir);
  assert.equal(r.status, 2, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, 'E_INPUT');
  assert.match(err.at, /orders\.jsonl:1/);
});

test('infeasible -> exit 3 with minimal conflict set', () => {
  // each order alone finishes at t=10 (due 15); together one must end at 22
  const dir = setup({
    ...BASE,
    'orders.jsonl':
      '{"id":"O1","mold":"M1","operator":"P1","qty":100,"due":15}\n' +
      '{"id":"O2","mold":"M2","operator":"P2","qty":100,"due":15}\n',
  });
  const r = run(planArgs(dir, dir), dir);
  assert.equal(r.status, 3, r.stderr);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, 'E_INFEASIBLE');
  assert.deepEqual(err.conflict.sort(), ['O1', 'O2']); // minimal: either alone is feasible
});

test('end-to-end: plan, undo, verify via CLI', () => {
  const dir = setup({
    ...BASE,
    'orders.jsonl':
      '{"id":"O1","mold":"M1","operator":"P1","qty":100,"due":1000}\n' +
      '{"id":"O2","mold":"M2","operator":"P2","qty":50,"due":1000}\n',
  });
  let r = run(planArgs(dir, dir), dir);
  assert.equal(r.status, 0, r.stderr);
  const planned = JSON.parse(r.stdout);
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.plan.seq, ['O1', 'O2']);

  r = run(['plan', '--dir', join(dir, 'data'), '--insert', '{"id":"O3","mold":"M1","operator":"P1","qty":30,"due":1000}'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'applied');

  r = run(['undo', '--dir', join(dir, 'data'), '--to', '1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).head, 1);

  r = run(['verify', '--dir', join(dir, 'data')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).ok);
});

test('unknown command -> exit 2 with usage', () => {
  const r = run(['frobnicate'], tmpdir());
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).code, 'E_INPUT');
});
