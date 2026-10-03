'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute, parseArgs } = require('../cli');
const { frame } = require('./helpers');

const DEFAULTS = { timeout: 2, retries: 3 };

function lines(output) {
  return output.trim().split('\n').map(JSON.parse);
}

test('cli args: --in/--out/--clock/--timeout/--retries parse', () => {
  const args = parseArgs(['--in', 'trace.hex', '--clock', '0', '--out', 'out.ndjson', '--timeout', '5', '--retries', '4']);
  assert.equal(args.in, 'trace.hex');
  assert.equal(args.out, 'out.ndjson');
  assert.equal(args.clock, 0);
  assert.equal(args.timeout, 5);
  assert.equal(args.retries, 4);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('cli: clean stream exits 0 with NDJSON events + certificate', () => {
  const hex = Buffer.concat([
    frame(0, 'WELD_START', { orderId: 'A', weldId: 'w0' }),
    frame(1, 'WELD_END', { orderId: 'A', weldId: 'w0' }),
    frame(2, 'UNDO', { orderId: 'A', targetSeq: 1 }),
  ]).toString('hex');
  const { code, output } = execute({ ...DEFAULTS }, `${hex}\n`);
  assert.equal(code, 0);
  const rows = lines(output);
  assert.deepEqual(rows[0], { event: 'WELD_START', seq: 0, orderId: 'A', weldId: 'w0' });
  assert.deepEqual(rows[1], { event: 'WELD_END', seq: 1, orderId: 'A', weldId: 'w0' });
  assert.deepEqual(rows[2], { event: 'WELD_END_REVERSED', seq: 2, orderId: 'A', targetSeq: 1 });
  assert.equal(rows[3].certificate.ok, true);
  assert.equal(rows[3].certificate.delivered, 3);
});

test('cli: --out file receives the same NDJSON (via main-equivalent flow)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weldgw-'));
  const outFile = path.join(dir, 'out.ndjson');
  const hex = frame(0, 'WELD_START', { orderId: 'S' }).toString('hex');
  const { code, output } = execute({ ...DEFAULTS }, hex);
  fs.writeFileSync(outFile, output);
  assert.equal(code, 0);
  const rows = lines(fs.readFileSync(outFile, 'utf8'));
  assert.equal(rows[0].event, 'WELD_START');
  assert.equal(rows.at(-1).certificate.ok, true);
});

test('cli: crc corruption emits {error:{code,offset}} and exit 2', () => {
  const good = frame(0, 'WELD_START', { orderId: 'A' });
  const bad = Buffer.from(good);
  bad[bad.length - 1] ^= 0xff;
  const { code, output } = execute({ ...DEFAULTS }, Buffer.concat([good, bad]).toString('hex'));
  assert.equal(code, 2);
  const rows = lines(output);
  assert.equal(rows[0].event, 'WELD_START'); // events before the error kept
  assert.deepEqual(rows.at(-1), { error: { code: 'CRC_MISMATCH', offset: good.length + good.length - 2 } });
});

test('cli: invalid hex char exits 2 with BAD_HEX offset', () => {
  const { code, output } = execute({ ...DEFAULTS }, '00x1');
  assert.equal(code, 2);
  assert.deepEqual(lines(output).at(-1), { error: { code: 'BAD_HEX', offset: 2 } });
});

test('cli: truncated tail exits 2 with TRUNCATED_FRAME', () => {
  const buf = frame(0, 'WELD_START', { orderId: 'A' });
  const { code, output } = execute({ ...DEFAULTS }, buf.subarray(0, buf.length - 1).toString('hex'));
  assert.equal(code, 2);
  assert.equal(lines(output).at(-1).error.code, 'TRUNCATED_FRAME');
});

test('cli: protocol violation exits 3 and keeps prior events', () => {
  const hex = Buffer.concat([
    frame(0, 'WELD_END', { orderId: 'A', weldId: 'w0' }),
    frame(1, 'UNDO', { orderId: 'B', targetSeq: 0 }), // cross-order
  ]).toString('hex');
  const { code, output } = execute({ ...DEFAULTS }, hex);
  assert.equal(code, 3);
  const rows = lines(output);
  assert.equal(rows[0].event, 'WELD_END');
  assert.equal(rows.at(-2).certificate.ok, false);
  assert.equal(rows.at(-1).error.code, 'CROSS_ORDER_UNDO');
});

test('cli: gap timeout exits 3 with SEQ_GAP_TIMEOUT', () => {
  const hex = frame(1, 'WELD_END', { orderId: 'A' }).toString('hex'); // seq 0 missing
  const { code, output } = execute({ timeout: 1, retries: 2 }, hex);
  assert.equal(code, 3);
  const rows = lines(output);
  assert.equal(rows.filter((r) => r.event === 'RETRANSMIT_REQUEST').length, 2);
  assert.equal(rows.at(-1).error.code, 'SEQ_GAP_TIMEOUT');
});
