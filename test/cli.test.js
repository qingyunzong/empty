import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from '../src/cli.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const spec = path.join(root, 'examples', 'reserve.lim');

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through main() with captured streams.
const run = (args) => {
  let out = '';
  let err = '';
  const code = main(args, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { code, out, err };
};

test('CLI: linearizable history exits 0 with all valid orders', () => {
  const r = run(['check', spec, path.join(root, 'examples', 'history-ok.json'), '--max', '8']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.linearizable, true);
  assert.deepEqual(out.validOrders, [['A', 'B', 'C']]);
});

test('CLI: PENDING history warns with E_PENDING but still checks', () => {
  const r = run(['check', spec, path.join(root, 'examples', 'history-pending.json')]);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.linearizable, true);
  assert.deepEqual(out.pending, ['A']);
  assert.equal(out.warnings[0].code, 'E_PENDING');
});

test('CLI: --strict-pending turns PENDING into exit code 4', () => {
  const r = run(['check', spec, path.join(root, 'examples', 'history-pending.json'), '--strict-pending']);
  assert.equal(r.code, 4);
  assert.match(r.err, /E_PENDING/);
});

test('CLI: non-linearizable history exits 1 with E_LINEAR', () => {
  const r = run(['check', spec, path.join(root, 'examples', 'history-conflict.json')]);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.out);
  assert.equal(out.linearizable, false);
  assert.equal(out.error.code, 'E_LINEAR');
});

test('CLI: duplicate release exits 2 with E_TYPE', () => {
  const r = run(['check', spec, path.join(root, 'examples', 'history-dup-release.json')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /E_TYPE/);
  assert.match(r.err, /duplicate release/);
});

test('CLI: too many operations exits 3 with E_BOUND', () => {
  const history = {
    history: Array.from({ length: 9 }, (_, i) => ({
      id: `op${i}`, op: 'reserve', order: 'o1', invoke: i + 1, response: i + 2, result: 'fail',
    })),
  };
  const tmp = path.join(root, 'test', '.tmp-bound.json');
  fs.writeFileSync(tmp, JSON.stringify(history));
  try {
    const r = run(['check', spec, tmp, '--max', '8']);
    assert.equal(r.code, 3);
    assert.match(r.err, /E_BOUND/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('CLI: embedded history block in the spec works without a JSON file', () => {
  const tmp = path.join(root, 'test', '.tmp-embedded.lim');
  fs.writeFileSync(tmp, `
account acct { capacity 6; strategy alpha { limit 6; } }
order o1 { account acct; strategy alpha; amount 6; }
history {
  op A = reserve o1 invoke 1 response 2 ok;
  op B = reserve o1 invoke 3 pending;
}
`);
  try {
    const r = run(['check', tmp]);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.linearizable, true);
    // B (pending reserve of the already-reserved o1) can only be excluded.
    assert.deepEqual(out.validOrders, [['A']]);
    assert.deepEqual(out.pending, ['B']);
  } finally {
    fs.unlinkSync(tmp);
  }
});
