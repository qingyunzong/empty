'use strict';
// Acceptance: empty input boundary; malformed input exits 9 with stderr.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('../src/cli');
const { tmpdir } = require('../helpers');

function makeIo(stdinText = '', env = {}) {
  const io = {
    out: '',
    err: '',
    readStdin: () => stdinText,
    writeOut(s) {
      io.out += s;
    },
    writeErr(s) {
      io.err += s;
    },
    env,
  };
  return io;
}

test('empty input file: zero clusters, valid certificate, exit 0', () => {
  const dir = tmpdir('recon-empty-');
  const input = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(input, '');
  const io = makeIo();
  const code = runCli(['run', input, '--state', path.join(dir, 'state')], io);
  assert.equal(code, 0);
  assert.equal(io.err, '');
  const lines = io.out.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'certificate');
  assert.deepEqual(lines[0].clusterIds, []);
  assert.equal(lines[0].eventCount, 0);
  const vio = makeIo();
  assert.equal(runCli(['verify', '--state', path.join(dir, 'state')], vio), 0);
  assert.equal(JSON.parse(vio.out).ok, true);
});

test('empty stdin: same boundary behavior', () => {
  const dir = tmpdir('recon-empty-stdin-');
  const io = makeIo('');
  const code = runCli(['run', '-', '--state', path.join(dir, 'state')], io);
  assert.equal(code, 0);
  const lines = io.out.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'certificate');
});

test('malformed JSON line: stderr message and exit code 9', () => {
  const dir = tmpdir('recon-bad-');
  const input = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(input, '{"type":"internal","id":"I1","amount":1,"date":"2026-01-01"}\nnot-json\n');
  const io = makeIo();
  const code = runCli(['run', input, '--state', path.join(dir, 'state')], io);
  assert.equal(code, 9);
  assert.match(io.err, /line 2: invalid JSON/);
  assert.equal(io.out, '');
});

test('invalid event semantics: exit code 9, nothing persisted', () => {
  const dir = tmpdir('recon-bad2-');
  const input = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(input, '{"type":"cancel","id":"NOPE"}\n');
  const io = makeIo();
  assert.equal(runCli(['run', input, '--state', path.join(dir, 'state')], io), 9);
  assert.match(io.err, /cannot cancel/);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'events.jsonl')), 'rejected event is not persisted');
});
