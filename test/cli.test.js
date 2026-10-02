import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

function runCliCapture(lines, { rawText, extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-'));
  const file = join(dir, 'events.jsonl');
  const text = rawText ?? lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  writeFileSync(file, text);
  const stdout = [];
  const stderr = [];
  const status = runCli([file, ...extraArgs], {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { status, stdout, stderr };
}

test('valid log exits 0 and emits JSONL with cert and windowHash', () => {
  const result = runCliCapture([
    { setWindow: { n: 5 } },
    { upsert: { id: 'e1', ts: 1, sym: 'BOOT' } },
    { upsert: { id: 'e2', ts: 2, sym: 'OK' } },
    { upsert: { id: 'e3', ts: 3, sym: 'CRIT' } },
  ]);
  assert.equal(result.status, 0);
  const outputs = result.stdout.map((line) => JSON.parse(line));
  assert.ok(outputs.length > 0);
  for (const output of outputs) {
    assert.ok(output.op === 'emit' || output.op === 'retractAlarm');
    assert.ok(typeof output.cert.pattern === 'string');
    assert.ok(typeof output.cert.start === 'string');
    assert.ok(typeof output.cert.end === 'string');
    assert.match(output.cert.fp, /^[0-9a-f]{16}$/);
    assert.match(output.windowHash, /^[0-9a-f]{16}$/);
  }
  assert.ok(outputs.some((o) => o.cert.pattern === 'boot-then-crit'));
});

test('non-integer ts exits 3', () => {
  const result = runCliCapture([{ upsert: { id: 'e1', ts: 1.5, sym: 'A' } }]);
  assert.equal(result.status, 3);
  assert.match(result.stderr.join('\n'), /ts must be an integer/);
});

test('window < 1 exits 3', () => {
  const result = runCliCapture([{ setWindow: { n: 0 } }]);
  assert.equal(result.status, 3);
  assert.match(result.stderr.join('\n'), /setWindow/);
});

test('duplicate retract exits 3', () => {
  const result = runCliCapture([
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { retract: { id: 'e1' } },
    { retract: { id: 'e1' } },
  ]);
  assert.equal(result.status, 3);
  assert.match(result.stderr.join('\n'), /unknown id/);
});

test('retract of never-seen id exits 3', () => {
  const result = runCliCapture([{ retract: { id: 'ghost' } }]);
  assert.equal(result.status, 3);
});

test('invalid JSON line exits 3', () => {
  const result = runCliCapture([], {
    rawText: '{"upsert":{"id":"e1","ts":1,"sym":"A"}}\nnot json\n',
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr.join('\n'), /invalid JSON/);
});

test('custom patterns file is honored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-'));
  const patternsFile = join(dir, 'patterns.json');
  writeFileSync(patternsFile, JSON.stringify([{ id: 'solo', parts: [{ lit: 'Z' }] }]));
  const result = runCliCapture([{ upsert: { id: 'e1', ts: 1, sym: 'Z' } }], {
    extraArgs: [patternsFile],
  });
  assert.equal(result.status, 0);
  const outputs = result.stdout.map((line) => JSON.parse(line));
  assert.deepEqual(outputs.map((o) => o.cert.pattern), ['solo']);
});

test('missing arguments exits 2 with usage', () => {
  const stderr = [];
  const status = runCli([], { out: () => {}, err: (line) => stderr.push(line) });
  assert.equal(status, 2);
  assert.match(stderr.join('\n'), /usage/);
});
