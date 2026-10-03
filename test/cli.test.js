import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-cli-'));
}

function run(args) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    stdout: (c) => (stdout += Buffer.isBuffer(c) ? c.toString('utf8') : c),
    stderr: (c) => (stderr += c),
  });
  return { code, stdout, stderr };
}

test('cli: commit / snapshot / read --tag / gc round-trip', () => {
  const dir = tmpdir();

  let r = run(['commit', '--db', dir, 'a=1', 'b=hello']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /committed seq=1/);

  r = run(['snapshot', '--db', dir, 'exp-1']);
  assert.match(r.stdout, /tag exp-1 -> seq=1/);

  run(['commit', '--db', dir, 'a=2', '--del', 'b']);
  run(['commit', '--db', dir, 'a=3']);

  // Latest view.
  assert.equal(run(['read', '--db', dir, 'a']).stdout.trim(), '3');
  // Tagged view is frozen.
  assert.equal(run(['read', '--db', dir, '--tag', 'exp-1', 'a']).stdout.trim(), '1');
  assert.equal(run(['read', '--db', dir, '--tag', 'exp-1', 'b']).stdout.trim(), 'hello');

  // Missing tag -> NO_TAG on stderr, non-zero exit.
  r = run(['read', '--db', dir, '--tag', 'missing', 'a']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NO_TAG/);

  // GC keeps the tagged snapshot readable.
  r = run(['gc', '--db', dir]);
  assert.match(r.stdout, /gc collected \d+ version/);
  assert.equal(run(['read', '--db', dir, '--tag', 'exp-1', 'a']).stdout.trim(), '1');

  // GC refuses an explicitly referenced horizon.
  r = run(['gc', '--db', dir, '--before', '3']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GC_REFUSED/);

  // Tags list.
  r = run(['tags', '--db', dir]);
  assert.match(r.stdout, /exp-1\t1/);
});
