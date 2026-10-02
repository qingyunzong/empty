// CLI tests drive runCli in-process (the sandbox forbids child processes);
// scripts/run-scenarios.sh exercises the real `node cli.js` entry point.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));

function makeRunner(dir) {
  return (args) => {
    const lines = [];
    const code = runCli(['--data', dir, ...args], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    return { code, text: lines.join('\n') };
  };
}

test('CLI: append, asof, counts, undo, verify', () => {
  const run = makeRunner(tmpdir());
  let r = run(['append', path.join(root, 'examples/sc1-tx1.json')]);
  assert.equal(r.code, 0);
  assert.match(r.text, /COMMIT tx_id=tx-001 events=1/);
  assert.match(r.text, /DELTA equipment=pump-7 date=2024-03-10 up=\+1 down=\+0/);

  r = run(['append', path.join(root, 'examples/sc1-tx2.json')]);
  assert.equal(r.code, 0);
  assert.match(r.text, /DELTA equipment=pump-7 date=2024-03-10 up=-1 down=\+1/);

  r = run(['asof', 'pump-7', '2024-03-10T00:00:00Z']);
  assert.match(r.text, /tx_time=CURRENT state=down/);
  r = run(['asof', 'pump-7', '2024-03-10T00:00:00Z', '2024-03-10T02:00:00Z']);
  assert.match(r.text, /state=up/);

  r = run(['counts']);
  assert.match(r.text, /COUNT equipment=pump-7 date=2024-03-10 up=0 down=1/);

  r = run(['verify']);
  assert.equal(r.code, 0);
  assert.match(r.text, /VERIFY OK/);

  r = run(['undo', 'tx-002']);
  assert.equal(r.code, 0);
  assert.match(r.text, /UNDO tx_id=tx-002/);
  assert.match(r.text, /DELTA equipment=pump-7 date=2024-03-10 up=\+1 down=-1/);
  r = run(['asof', 'pump-7', '2024-03-10T00:00:00Z']);
  assert.match(r.text, /state=up/);
});

test('CLI: invalid batch exits 1 and leaves counts and hash unchanged', () => {
  const run = makeRunner(tmpdir());
  assert.equal(run(['append', path.join(root, 'examples/sc3-tx1.json')]).code, 0);
  const hashBefore = run(['hash']).text;
  const countsBefore = run(['counts']).text;

  const r = run(['append', path.join(root, 'examples/sc3-bad.json')]);
  assert.equal(r.code, 1);
  assert.match(r.text, /REJECT tx_id=tx-202/);
  assert.match(r.text, /PROBLEM events\[1\]\.state/);
  assert.match(r.text, /PROBLEM events\[2\]\.valid_time/);

  assert.equal(run(['hash']).text, hashBefore);
  assert.equal(run(['counts']).text, countsBefore);
});

test('CLI: out-of-order tx_time stays invisible in the current view', () => {
  const run = makeRunner(tmpdir());
  run(['append', path.join(root, 'examples/sc2-txA.json')]);
  const r = run(['append', path.join(root, 'examples/sc2-txB.json')]);
  assert.equal(r.code, 0);
  assert.match(r.text, /DELTA \(none\)/);
  assert.match(run(['asof', 'valve-3', '2024-05-01T00:00:00Z']).text, /state=up/);
  assert.match(
    run(['asof', 'valve-3', '2024-05-01T00:00:00Z', '2024-05-07T00:00:00Z']).text,
    /state=down/,
  );
  assert.match(
    run(['asof', 'valve-3', '2024-05-01T00:00:00Z', '2024-05-04T00:00:00Z']).text,
    /state=NONE/,
  );
});
