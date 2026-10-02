import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function cli(args) {
  const out = [];
  const err = [];
  const status = run(args, {
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

test('settle ok.jsonl: exit 0, nets sum to zero', () => {
  const r = cli(['settle', 'examples/ok.jsonl', '--base', 'CNY']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'ok');
  assert.equal(out.total, '0');
  assert.equal(out.balanced, true);
  assert.equal(out.nets.length, 3);
});

test('settle conflict.jsonl: exit 1 with certificate, verify accepts it', () => {
  const r = cli(['settle', 'examples/conflict.jsonl', '--base', 'CNY']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'infeasible');
  const dir = mkdtempSync(join(tmpdir(), 'fxsettle-'));
  const certPath = join(dir, 'cert.json');
  writeFileSync(certPath, JSON.stringify(out.certificate));
  const v = cli(['verify', 'examples/conflict.jsonl', certPath]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(JSON.parse(v.stdout).valid, true);
});

test('settle pending.jsonl: exit 4 with E_PENDING, not infeasible', () => {
  const r = cli(['settle', 'examples/pending.jsonl', '--base', 'CNY']);
  assert.equal(r.status, 4);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'pending');
  assert.equal(out.error.code, 'E_PENDING');
});

test('E_PARSE exits 2, E_REF exits 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsettle-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{oops\n');
  const r1 = cli(['settle', bad]);
  assert.equal(r1.status, 2);
  assert.equal(JSON.parse(r1.stderr).error.code, 'E_PARSE');
  const badref = join(dir, 'badref.jsonl');
  writeFileSync(badref, '{"type":"undo","eventId":"ghost"}\n');
  const r2 = cli(['settle', badref]);
  assert.equal(r2.status, 3);
  assert.equal(JSON.parse(r2.stderr).error.code, 'E_REF');
});

test('hash: undo restores the history hash (acceptance 4 via CLI)', () => {
  const h1 = cli(['hash', 'examples/ok.jsonl']);
  const h2 = cli(['hash', 'examples/undo_demo.jsonl']);
  assert.equal(h1.status, 0);
  assert.equal(h2.status, 0);
  assert.equal(h1.stdout.trim(), h2.stdout.trim());
});

test('usage error exits 64', () => {
  const r = cli(['frobnicate']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage/);
});
