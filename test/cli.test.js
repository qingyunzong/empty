import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRun, tmpdir } from '../testkit/helpers.js';

const CLI = fileURLToPath(new URL('../bin/rundiff.js', import.meta.url));

// NOTE: this sandboxed environment drops grandchild stdio pipes, so tests
// assert on exit codes and on the persisted query/error files instead of
// captured stdout/stderr.
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function setup() {
  const dir = tmpdir();
  const store = `${dir}/store`;
  const schema = { tables: { metrics: { key: 'id', dependsOn: ['lr'] } } };
  makeRun(`${dir}/runA`, {
    params: { lr: 0.001, seed: 1 },
    schema,
    data: { metrics: 'id,loss\n1,0.5\n2,0.6\n3,0.7\n' },
  });
  makeRun(`${dir}/runB`, {
    params: { lr: 0.01, seed: 1 },
    schema,
    data: { metrics: 'id,loss\n1,0.5\n2,0.65\n4,0.9\n' },
  });
  const env = { RUNDIFF_STORE: store };
  assert.equal(cli(['snap', `${dir}/runA`], env).status, 0);
  assert.equal(cli(['snap', `${dir}/runB`], env).status, 0);
  return { dir, env, store };
}

test('e2e: snap, diff, minexplain, recheck MATCH', () => {
  const { env, store } = setup();
  assert.equal(cli(['diff', 'runA', 'runB'], env).status, 0);
  const dq = readJson(`${store}/queries/last.json`);
  assert.equal(dq.type, 'diff');
  const d = dq.result;
  assert.deepEqual(d.params, [{ path: 'lr', a: 0.001, b: 0.01 }]);
  assert.deepEqual(d.tables.metrics.onlyInA, ['F3']);
  assert.deepEqual(d.tables.metrics.onlyInB, ['F4']);
  assert.equal(d.tables.metrics.changed.length, 1);

  assert.equal(cli(['minexplain', 'runA', 'runB'], env).status, 0);
  const mq = readJson(`${store}/queries/last.json`);
  assert.equal(mq.type, 'minexplain');
  assert.deepEqual(mq.result.explanations, [['param:lr']]);

  const re = cli(['recheck'], env);
  assert.equal(re.status, 0, 'recheck should report MATCH');
});

test('e2e: minexplain --one on ambiguous diff exits with E_AMBIG_MIN', () => {
  const dir = tmpdir();
  const store = `${dir}/store`;
  const env = { RUNDIFF_STORE: store };
  const schema = { tables: { t: { key: 'id', dependsOn: ['p1', 'p2'] } } };
  makeRun(`${dir}/a`, { params: { p1: 1, p2: 1 }, schema, data: { t: 'id,v\n1,1\n' } });
  makeRun(`${dir}/b`, { params: { p1: 2, p2: 2 }, schema, data: { t: 'id,v\n1,2\n' } });
  cli(['snap', `${dir}/a`], env);
  cli(['snap', `${dir}/b`], env);
  const r = cli(['minexplain', 'a', 'b', '--one'], env);
  assert.equal(r.status, 1);
  assert.equal(readJson(`${store}/last-error.json`).code, 'E_AMBIG_MIN');
});

test('e2e: diff on missing snapshot exits with E_SNAP', () => {
  const dir = tmpdir();
  const store = `${dir}/store`;
  const r = cli(['diff', 'nope', 'nope2'], { RUNDIFF_STORE: store });
  assert.equal(r.status, 1);
  assert.equal(readJson(`${store}/last-error.json`).code, 'E_SNAP');
});

test('e2e: invalid tolerance flag exits with E_TOL', () => {
  const { env, store } = setup();
  const r = cli(['diff', 'runA', 'runB', '--tol-abs', '-1'], env);
  assert.equal(r.status, 1);
  assert.equal(readJson(`${store}/last-error.json`).code, 'E_TOL');
});

test('e2e: diff query is replayable after patch undo (recheck MATCH)', () => {
  const { dir, env } = setup();
  assert.equal(cli(['diff', 'runA', 'runB'], env).status, 0);
  const changeFile = `${dir}/c1.json`;
  fs.writeFileSync(changeFile, JSON.stringify({ set: { lr: 0.5 } }));
  assert.equal(cli(['patch', `${dir}/runB`, changeFile], env).status, 0);
  const undoFile = `${dir}/c2.json`;
  fs.writeFileSync(undoFile, JSON.stringify({ set: { lr: 0.01 } }));
  assert.equal(cli(['patch', `${dir}/runB`, undoFile], env).status, 0);
  const re = cli(['recheck'], env);
  assert.equal(re.status, 0, 'recheck should report MATCH after undo');
});
