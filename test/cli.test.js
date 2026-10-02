'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

// The offline sandbox forbids spawning child processes, so the CLI is
// exercised in-process through its exported run(argv, io) entry point,
// which returns the same exit codes the process wrapper would produce.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-cli-'));
  const store = path.join(dir, 'store');
  const invoke = (args) => {
    let out = '';
    let err = '';
    const status = run([...args, '--store', store], {
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
    });
    return { status, stdout: out, stderr: err };
  };
  const addVersion = (v) => {
    const file = path.join(dir, `v${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(v));
    return invoke(['add', file]);
  };
  return { dir, store, invoke, addVersion };
}

const base = { author: 'n1', clock: { n1: 1 }, parents: [], results: {}, evidence: [] };

test('add stores a version and prints its hash', () => {
  const { invoke, addVersion, store } = setup();
  const res = addVersion(base);
  assert.equal(res.status, 0, res.stderr);
  const hash = res.stdout.trim();
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(store, `${hash}.json`)));
  const cmp = invoke(['compare', hash, hash]);
  assert.equal(cmp.stdout.trim(), 'equal');
});

test('unknown parent reference exits 1', () => {
  const { addVersion } = setup();
  const res = addVersion({ ...base, parents: ['deadbeef'] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown parent reference/);
});

test('clock regression exits 1', () => {
  const { addVersion } = setup();
  const parent = addVersion({ ...base, clock: { n1: 2 } });
  assert.equal(parent.status, 0, parent.stderr);
  const res = addVersion({ ...base, clock: { n1: 1 }, parents: [parent.stdout.trim()] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /clock regression/i);
});

test('duplicate evidence id exits 1', () => {
  const { addVersion } = setup();
  const res = addVersion({
    ...base,
    evidence: [{ id: 'e1', label: 'a' }, { id: 'e1', label: 'b' }],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /duplicate evidence id/);
});

test('compatible concurrent merge exits 0 and creates a merge commit', () => {
  const { invoke, addVersion, store } = setup();
  const b = addVersion(base).stdout.trim();
  const left = addVersion({
    author: 'n1', clock: { n1: 2 }, parents: [b], results: { alpha: 1 }, evidence: [],
  }).stdout.trim();
  const right = addVersion({
    author: 'n2', clock: { n1: 1, n2: 1 }, parents: [b], results: { beta: 2 }, evidence: [],
  }).stdout.trim();

  const res = invoke(['merge', left, right]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.head.results, { alpha: 1, beta: 2 });
  assert.deepEqual(out.head.clock, { n1: 2, n2: 1 });
  assert.ok(fs.existsSync(path.join(store, `${out.head.hash}.json`)));
});

test('fast-forward merge exits 0 without creating a commit', () => {
  const { invoke, addVersion, store } = setup();
  const a = addVersion(base).stdout.trim();
  const b = addVersion({ ...base, clock: { n1: 2 }, parents: [a] }).stdout.trim();
  const before = fs.readdirSync(store).length;
  const res = invoke(['merge', a, b]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'fast-forward');
  assert.equal(fs.readdirSync(store).length, before);
});

test('contradiction exits 2, writes pairwise-conflicts.json, creates no merge commit', () => {
  const { dir, invoke, addVersion, store } = setup();
  const b = addVersion(base).stdout.trim();
  const left = addVersion({
    author: 'n1', clock: { n1: 2 }, parents: [b],
    results: {}, evidence: [{ id: 'e1', label: 'positive' }],
  }).stdout.trim();
  const right = addVersion({
    author: 'n2', clock: { n1: 1, n2: 1 }, parents: [b],
    results: {}, evidence: [{ id: 'e2', label: 'negative' }],
  }).stdout.trim();

  const certPath = path.join(dir, 'pairwise-conflicts.json');
  const before = fs.readdirSync(store).length;
  const res = invoke(['merge', left, right, '--conflicts', certPath]);
  assert.equal(res.status, 2, res.stderr);

  assert.ok(fs.existsSync(certPath), 'pairwise-conflicts.json written');
  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  assert.equal(cert.type, 'pairwise-conflicts');
  assert.deepEqual(cert.versions, [left, right]);
  assert.equal(cert.conflicts[0].kind, 'exclusive-evidence');
  assert.equal(fs.readdirSync(store).length, before, 'no merge commit created');
});
