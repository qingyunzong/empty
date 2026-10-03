'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli-core');

const ROOT = path.join(__dirname, '..');
const RECORDS = path.join(ROOT, 'fixtures', 'records.json');
const SCHEMA = path.join(ROOT, 'fixtures', 'schema.json');

function makeIo() {
  const io = {
    out: '',
    err: '',
    stdout(text) { io.out += text; },
    stderr(text) { io.err += text; },
    readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    exists: (p) => fs.existsSync(p),
  };
  return io;
}

function runCliCapture(args) {
  const io = makeIo();
  const status = runCli(args, io);
  return { status, stdout: io.out, stderr: io.err };
}

test('cli prints hits, instruction count and certificate', () => {
  const res = runCliCapture([
    '--records', RECORDS,
    '--schema', SCHEMA,
    '--query', 'source:email and severity >= 3',
  ]);
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepStrictEqual(out.hits, ['EV-001', 'EV-005']);
  assert.strictEqual(out.instructions, 56);
  assert.strictEqual(out.certificate.budget, 10000);
  assert.strictEqual(out.certificate.schemaHash.length, 64);
  assert.deepStrictEqual(out.certificate.hits, out.hits);
});

test('cli exits 1 with no output when budget is below enumeration cost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-cli-'));
  const state = path.join(dir, 'state.json');
  const base = ['--records', RECORDS, '--schema', SCHEMA, '--state', state];

  const ok = runCliCapture([...base, '--query', 'source:email']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const stateBefore = fs.readFileSync(state, 'utf8');

  const failing = runCliCapture([...base, '--query', 'source:email', '--budget', '23']);
  assert.strictEqual(failing.status, 1);
  assert.strictEqual(failing.stdout, '');
  assert.match(failing.stderr, /BUDGET/);
  assert.strictEqual(fs.readFileSync(state, 'utf8'), stateBefore);
});

test('cli exits 1 on unknown field and on string < comparison', () => {
  const base = ['--records', RECORDS, '--schema', SCHEMA];
  const unknown = runCliCapture([...base, '--query', 'nosuchfield:x']);
  assert.strictEqual(unknown.status, 1);
  assert.strictEqual(unknown.stdout, '');
  assert.match(unknown.stderr, /SCHEMA/);

  const badCompare = runCliCapture([...base, '--query', 'title < "abc"']);
  assert.strictEqual(badCompare.status, 1);
  assert.strictEqual(badCompare.stdout, '');
  assert.match(badCompare.stderr, /TYPE/);
});

test('cli exits 1 on invalid regex', () => {
  const res = runCliCapture([
    '--records', RECORDS, '--schema', SCHEMA, '--query', 'notes:/[unclosed/',
  ]);
  assert.strictEqual(res.status, 1);
  assert.strictEqual(res.stdout, '');
  assert.match(res.stderr, /REGEX/);
});

test('cli supports undo and redo through the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-cli-'));
  const state = path.join(dir, 'state.json');
  const base = ['--records', RECORDS, '--schema', SCHEMA, '--state', state];

  runCliCapture([...base, '--query', 'source:email']);
  runCliCapture([...base, '--query', 'severity >= 5']);

  const undo = runCliCapture([...base, '--undo']);
  assert.strictEqual(undo.status, 0, undo.stderr);
  assert.deepStrictEqual(JSON.parse(undo.stdout).hits, ['EV-001', 'EV-005', 'EV-008']);

  const redo = runCliCapture([...base, '--redo']);
  assert.strictEqual(redo.status, 0, redo.stderr);
  assert.deepStrictEqual(JSON.parse(redo.stdout).hits, ['EV-002', 'EV-004', 'EV-006']);
});
