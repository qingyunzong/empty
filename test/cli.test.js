'use strict';

// CLI tests run in-process because the sandbox forbids child processes;
// cli.run() is the exact code path the `node cli.js` entry point uses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');
const { encodeStream } = require('../lib/frame');

const KEY = 'hotel-preauth-secret';
const f = (authId, type, amount, seq, ack = 0) => ({ authId, type, amount, seq, ack });

function withBin(frames, fn, { corrupt } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preauth-'));
  const file = path.join(dir, 'frames.bin');
  let buf = encodeStream(frames, KEY);
  if (corrupt) buf = corrupt(buf);
  fs.writeFileSync(file, buf);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('cli prints frozen/charged/available report and exits 0', () => {
  withBin([f('A', 'hold', 500, 1), f('A', 'inc', 700, 2), f('A', 'complete', 900, 3)], (file) => {
    const r = run([file, '--limit', '1000']);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    const a = report.auths.A;
    assert.equal(a.status, 'COMPLETED');
    assert.equal(a.frozen, 0);
    assert.equal(a.charged, 900);
    assert.equal(a.available, 100);
    assert.equal(a.ack, 3);
    assert.ok(a.certificate.some((c) => c.event === 'inc_partial'));
  });
});

test('cli exits 2 on mac error', () => {
  withBin([f('A', 'hold', 100, 1), f('A', 'inc', 50, 2)], (file) => {
    const r = run([file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /mac mismatch/);
  }, { corrupt: (buf) => { buf[buf.length - 1] ^= 0xff; return buf; } });
});

test('cli exits 3 on conflicting retransmission', () => {
  withBin([f('A', 'hold', 100, 1), f('A', 'inc', 50, 2), f('A', 'inc', 60, 2)], (file) => {
    const r = run([file]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /conflict/);
  });
});

test('cli exits 4 when complete would drive frozen negative', () => {
  withBin([f('A', 'hold', 300, 1), f('A', 'complete', 500, 2)], (file) => {
    const r = run([file, '--limit', '1000']);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /negative frozen/);
  });
});

test('cli exits 1 on missing file / bad usage', () => {
  assert.equal(run([]).code, 1);
  assert.equal(run(['/nonexistent/frames.bin']).code, 1);
});

test('cli rejects truncated stream with exit 1', () => {
  withBin([f('A', 'hold', 100, 1)], (file) => {
    const r = run([file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /truncated/);
  }, { corrupt: (buf) => buf.subarray(0, buf.length - 3) });
});

test('cli honors --ttl for virtual-clock expiry', () => {
  withBin([
    f('A', 'hold', 400, 1),
    f('B', 'hold', 10, 1), f('B', 'inc', 5, 2), f('B', 'dec', 1, 3), f('B', 'void', 0, 4),
    f('A', 'inc', 100, 2),
  ], (file) => {
    const r = run([file, '--limit', '1000', '--ttl', '3']);
    assert.equal(r.code, 0, r.stderr);
    const a = JSON.parse(r.stdout).auths.A;
    assert.equal(a.status, 'VOIDED');
    assert.ok(a.certificate.some((c) => c.event === 'auto_void'));
    assert.ok(a.certificate.some((c) => c.event === 'rejected' && /late inc/.test(c.note)));
  });
});
