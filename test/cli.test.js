'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');
const { start, end, undo, stream, toHex } = require('../testlib/helpers');

// In-process CLI harness: the sandbox forbids spawning child processes,
// so cli.js exposes main(argv, io) with injectable IO.
function runCli(args, { stdin = '', files = {} } = {}) {
  const written = {};
  let stdout = '';
  let stderr = '';
  const io = {
    readStdin: () => stdin,
    readFile: (p) => {
      if (p in files) return files[p];
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      throw new Error(`ENOENT: ${p}`);
    },
    writeOut: (s) => { stdout += s; },
    writeFile: (p, s) => {
      written[p] = s;
      if (path.isAbsolute(p)) fs.writeFileSync(p, s);
    },
    writeErr: (s) => { stderr += s; },
  };
  const code = main(args, io);
  return { code, stdout, stderr, written };
}

function parseLines(text) {
  return text.trim().split('\n').map(JSON.parse);
}

test('cli: file in, file out, exit 0 with events + certificate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weld-gw-'));
  const trace = path.join(dir, 'trace.hex');
  const out = path.join(dir, 'out.ndjson');
  fs.writeFileSync(trace, toHex(stream(start('WO-1', 0), end('WO-1', 1), undo('WO-1', 2))));
  const r = runCli(['--in', trace, '--clock', '0', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const lines = parseLines(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(lines.map((l) => l.type), ['weld_start', 'weld_end', 'weld_undo', 'certificate']);
  assert.equal(lines[2].undoes, lines[1].id);
  assert.equal(lines[3].events, 3);
});

test('cli: stdin hex with whitespace, events to stdout', () => {
  const hex = toHex(stream(start('WO-9', 0), end('WO-9', 1)));
  const pretty = hex.replace(/(..)/g, '$1 ').trim() + '\n';
  const r = runCli([], { stdin: pretty });
  assert.equal(r.code, 0, r.stderr);
  const lines = parseLines(r.stdout);
  assert.deepEqual(lines.map((l) => l.type), ['weld_start', 'weld_end', 'certificate']);
});

test('cli: parse error exits 2 with {error:{code,offset}}', () => {
  const good = start('WO-1', 0);
  const corrupt = Buffer.from(end('WO-1', 1));
  corrupt[9] ^= 0x01; // break the CRC
  const trace = toHex(stream(good, corrupt));
  const r = runCli(['--in', 'trace.hex'], { files: { 'trace.hex': trace } });
  assert.equal(r.code, 2, r.stderr);
  const lines = parseLines(r.stdout);
  const last = lines[lines.length - 1];
  assert.deepEqual(last, { error: { code: 'BAD_CRC', offset: good.length } });
  assert.deepEqual(lines.slice(0, -1).map((l) => l.type), ['weld_start']);
});

test('cli: bad hex input exits 2', () => {
  const r = runCli([], { stdin: 'ab cd zz' });
  assert.equal(r.code, 2);
  const last = parseLines(r.stdout).pop();
  assert.deepEqual(last, { error: { code: 'BAD_HEX', offset: 4 } });
});

test('cli: protocol violation exits 3, state unchanged', () => {
  const trace = toHex(stream(start('WO-A', 0), end('WO-A', 1), undo('WO-B', 2)));
  const r = runCli(['--in', 'undo.hex', '--out', 'out.ndjson'], {
    files: { 'undo.hex': trace },
  });
  assert.equal(r.code, 3, r.stderr);
  const lines = parseLines(r.written['out.ndjson']);
  const last = lines[lines.length - 1];
  assert.equal(last.error.code, 'UNDO_NOT_ALLOWED');
  assert.deepEqual(lines.slice(0, -1).map((l) => l.type), ['weld_start', 'weld_end']);
});

test('cli: truncated stream exits 2', () => {
  const half = toHex(start('WO-1', 0)).slice(0, 10); // 5 bytes of a 12-byte frame
  const r = runCli([], { stdin: half });
  assert.equal(r.code, 2);
  const last = parseLines(r.stdout).pop();
  assert.deepEqual(last, { error: { code: 'TRUNCATED', offset: 0 } });
});

test('cli: unknown argument exits 4', () => {
  const r = runCli(['--bogus']);
  assert.equal(r.code, 4);
});
