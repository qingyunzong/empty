'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli.js');

function makeIo() {
  const io = {
    out: [],
    err: [],
    stdout(line) { this.out.push(line); },
    stderr(line) { this.err.push(line); },
  };
  return io;
}

async function withJsonl(lines, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dives-')), 'dives.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  try {
    return await fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const T0 = '2026-10-04T00:00:00Z';
const MIN = 60 * 1000;
const iso = (offsetMin) => new Date(Date.parse(T0) + offsetMin * MIN).toISOString();

test('CLI processes a full dive session and emits a certificate', async () => {
  const lines = [
    JSON.stringify({ type: 'UPSERT', profileId: 'b1', depth: 30, temp: 8.4, version: 1, eventTime: iso(0) }),
    JSON.stringify({ type: 'UPSERT', profileId: 'b1', depth: 10, temp: 7.0, version: 1, eventTime: iso(1) }),
    JSON.stringify({ type: 'UPSERT', profileId: 'b1', depth: 20, temp: 8.0, version: 1, eventTime: iso(2) }),
    JSON.stringify({ type: 'RETRACT', profileId: 'b1', depth: 20, version: 2, eventTime: iso(3) }),
    JSON.stringify({ type: 'WATERMARK', profileId: 'b1', time: iso(34) }),
  ];
  await withJsonl(lines, async (file) => {
    const io = makeIo();
    const code = await run(['node', 'cli.js', 'profiles', '--in', file], io);
    assert.equal(code, 0);
    assert.deepEqual(io.err, []);
    const out = io.out.map(JSON.parse);
    assert.equal(out.length, 5);
    assert.equal(out[0].type, 'upsert');
    assert.equal(out[3].type, 'retract');
    assert.deepEqual(out[3].missing.blocks, [{ start: 11, end: 29, count: 19 }]);
    const cert = out[4];
    assert.equal(cert.type, 'certificate');
    assert.deepEqual(cert.depths, [10, 30]);
    assert.deepEqual(cert.inversions, [[10, 30]]);
    assert.deepEqual(cert.maxInversionLayer, { from: 10, to: 30, pairCount: 1 });
  });
});

test('CLI emits LATE rejection after certificate on stdout, exit 0', async () => {
  const lines = [
    JSON.stringify({ type: 'UPSERT', profileId: 'b2', depth: 10, temp: 7, version: 1, eventTime: iso(0) }),
    JSON.stringify({ type: 'WATERMARK', profileId: 'b2', time: iso(31) }),
    JSON.stringify({ type: 'UPSERT', profileId: 'b2', depth: 10, temp: 8, version: 2, eventTime: iso(32) }),
  ];
  await withJsonl(lines, async (file) => {
    const io = makeIo();
    const code = await run(['node', 'cli.js', 'profiles', '--in', file], io);
    assert.equal(code, 0);
    const out = io.out.map(JSON.parse);
    assert.deepEqual(out.map((r) => r.type), ['upsert', 'certificate', 'rejected']);
    assert.equal(out[2].reason, 'LATE');
  });
});

test('CLI reports malformed JSON to stderr as JSON and exits 2', async () => {
  await withJsonl(['{"type":"UPSERT"', '{not json'], async (file) => {
    const io = makeIo();
    const code = await run(['node', 'cli.js', 'profiles', '--in', file], io);
    assert.equal(code, 2);
    const err = JSON.parse(io.err[0]);
    assert.equal(err.line, 1);
    assert.match(err.error, /invalid JSON/);
  });
});

test('CLI rejects schema violations with exit 2', async () => {
  const bad = [
    JSON.stringify({ type: 'UPSERT', profileId: 'b', depth: 10, version: 1, eventTime: iso(0) }), // missing temp
    JSON.stringify({ type: 'BOGUS', profileId: 'b' }),
    JSON.stringify({ type: 'WATERMARK', profileId: 'b', time: 'not-a-time' }),
  ];
  for (const line of bad) {
    await withJsonl([line], async (file) => {
      const io = makeIo();
      const code = await run(['node', 'cli.js', 'profiles', '--in', file], io);
      assert.equal(code, 2, line);
      const err = JSON.parse(io.err[0]);
      assert.ok(err.error);
      assert.equal(err.line, 1);
    });
  }
});

test('CLI usage errors exit 2', async () => {
  for (const argv of [
    ['node', 'cli.js'],
    ['node', 'cli.js', 'profiles'],
    ['node', 'cli.js', 'bogus', '--in', 'x'],
    ['node', 'cli.js', 'profiles', '--in', '/nonexistent/dives.jsonl'],
  ]) {
    const io = makeIo();
    const code = await run(argv, io);
    assert.equal(code, 2, argv.join(' '));
    assert.ok(JSON.parse(io.err[0]).error);
  }
});
