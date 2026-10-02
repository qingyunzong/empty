'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');
const { encode, TYPE } = require('../src/frame');
const { crc32 } = require('../src/crc32');

function runCli(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xsettle-')), 'in.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return run(file);
}

test('cli: happy path exits 0 with code OK and full report', () => {
  const { exitCode, out } = runCli([
    '{"op":"account","id":"A","balance":1000}',
    '{"op":"account","id":"B","balance":0}',
    '{"op":"submit","batchId":1,"lines":[{"lineNo":1,"from":"A","to":"B","amount":40}]}',
    '{"op":"send","batchId":1}',
    '{"op":"deliver","count":"all"}',
    '{"op":"settle","batchId":1,"lineNo":1}',
  ]);
  assert.equal(exitCode, 0);
  assert.equal(out.code, 'OK');
  assert.equal(out.lines[0].state, 'SETTLED');
  assert.equal(out.accounts.find((a) => a.id === 'A').frozen, 0);
  assert.equal(out.accounts.find((a) => a.id === 'B').balance, 40);
  assert.equal(typeof out.audit.head, 'string');
  assert.equal(out.audit.head.length, 64);
});

test('cli: business rejection exits 3 with code in JSON', () => {
  const { exitCode, out } = runCli([
    '{"op":"account","id":"A","balance":100}',
    '{"op":"account","id":"B","balance":0}',
    '{"op":"submit","batchId":1,"lines":[{"lineNo":1,"from":"A","to":"B","amount":40}]}',
    '{"op":"settle","batchId":1,"lineNo":1}',
  ]);
  assert.equal(exitCode, 3);
  assert.equal(out.code, 'BUSINESS_REJECTED');
  assert.ok(out.error);
});

test('cli: protocol error (bad frame version) exits 2 with code in JSON', () => {
  const wire = encode({ type: TYPE.DATA, batchId: 1, lineNo: 1, seq: 0, ack: 0, payload: Buffer.from('{}') });
  wire[2] = 99; // unsupported version, fix CRC so it is a genuine version violation
  wire.writeUInt32BE(crc32(wire.subarray(0, wire.length - 4)), wire.length - 4);
  const { exitCode, out } = runCli([
    '{"op":"account","id":"A","balance":100}',
    '{"op":"account","id":"B","balance":0}',
    '{"op":"submit","batchId":1,"lines":[{"lineNo":1,"from":"A","to":"B","amount":1}]}',
    JSON.stringify({ op: 'link', action: 'raw', hex: wire.toString('hex') }),
    '{"op":"deliver","count":"all"}',
  ]);
  assert.equal(exitCode, 2);
  assert.equal(out.code, 'BAD_VERSION');
});

test('cli: malformed input line exits 2', () => {
  const { exitCode, out } = runCli(['{"op":"account",']);
  assert.equal(exitCode, 2);
  assert.equal(out.code, 'BAD_INPUT');
});

test('cli: missing file argument exits 2', () => {
  const { exitCode, out } = run(undefined);
  assert.equal(exitCode, 2);
  assert.equal(out.code, 'BAD_INPUT');
});
