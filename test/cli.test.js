import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, EXIT } from '../src/cli.js';
import { tmpRoot, at } from './helpers.js';

const E_REFERENCE = 'E_REFERENCE';


// Drives the real CLI code path (argument parsing, store operations, error
// mapping) in-process and captures exactly what bin/qc.js would print and
// which exit code it would set.
function cli(root, args) {
  let out = '';
  let err = '';
  const code = run(['--root', root, ...args], {
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  return { code, stdout: out, stderr: err, json: () => JSON.parse(out) };
}

test('CLI end-to-end: init, measure, correct, show, as-of, find, list, scan', () => {
  const root = tmpRoot();

  let r = cli(root, ['init', 'LOT-1', '--baseline', '100', '--min', '95', '--max', '105', '--chunk-size', '2', '--at', at(0)]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.json().effective.value, 100);

  r = cli(root, ['measure', 'LOT-1', '--value', '106', '--at', at(1)]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.json().effective.judgment, 'fail');

  r = cli(root, ['show', 'LOT-1']);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.json().effective.value, 106);
  assert.equal(r.json().effective.judgment, 'fail');

  r = cli(root, ['correct', 'LOT-1', '--refs', '1', '--value', '104', '--reason', 'late recalibration', '--at', at(2)]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.json().effective.judgment, 'pass');
  assert.equal(r.json().correctionReason, 'late recalibration');

  // audit replay of the old judgment
  r = cli(root, ['show', 'LOT-1', '--as-of', '1']);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.json().effective.value, 106);
  assert.equal(r.json().effective.judgment, 'fail');

  r = cli(root, ['find', 'LOT-1', '--at', at(1)]);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.json().seq, 1);
  assert.equal(r.json().value, 106);

  r = cli(root, ['list']);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(r.json().map((b) => b.batchId), ['LOT-1']);

  r = cli(root, ['scan']);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.json()[0].status, 'ok');
});

test('CLI exit codes: E_REFERENCE -> 4, E_CRC -> 3, usage -> 2', () => {
  const root = tmpRoot();
  cli(root, ['init', 'LOT-2', '--baseline', '100', '--min', '95', '--max', '105', '--chunk-size', '1', '--at', at(0)]);
  cli(root, ['measure', 'LOT-2', '--value', '101', '--at', at(1)]);

  let r = cli(root, ['correct', 'LOT-2', '--refs', '77', '--value', '100', '--reason', 'dangling']);
  assert.equal(r.code, EXIT[E_REFERENCE]);
  assert.match(r.stderr, /E_REFERENCE/);

  // corrupt the second chunk on disk
  const chunk2 = path.join(root, 'LOT-2', 'chunks', '000002.chk');
  const buf = fs.readFileSync(chunk2);
  buf[buf.length - 2] = buf[buf.length - 2] ^ 0xff;
  fs.writeFileSync(chunk2, buf);

  r = cli(root, ['show', 'LOT-2']);
  assert.equal(r.code, EXIT.E_CRC);
  assert.match(r.stderr, /E_CRC/);

  // scan still exits 0 and reports the damaged batch
  r = cli(root, ['scan']);
  assert.equal(r.code, EXIT.ok);
  const report = r.json();
  assert.equal(report[0].status, 'error');
  assert.equal(report[0].error, 'E_CRC');
  assert.equal(report[0].recovered, 1);

  r = cli(root, ['frobnicate']);
  assert.equal(r.code, EXIT.usage);
});

test('CLI unknown batch exits non-zero with E_NOT_FOUND', () => {
  const root = tmpRoot();
  const r = cli(root, ['show', 'NOPE']);
  assert.equal(r.code, EXIT.generic);
  assert.match(r.stderr, /E_NOT_FOUND/);
});
