import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const patternsPath = join(root, 'patterns.example.json');

function makeIo() {
  const io = { out: '', err: '' };
  io.stdout = (s) => {
    io.out += s;
  };
  io.stderr = (s) => {
    io.err += s;
  };
  return io;
}

function withEvents(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-gateway-'));
  const eventsPath = join(dir, 'events.jsonl');
  writeFileSync(eventsPath, `${lines.join('\n')}\n`);
  return fn(eventsPath);
}

test('CLI processes a valid log and emits JSON lines', () => {
  const io = makeIo();
  const code = run(['events.example.jsonl', '--patterns', patternsPath], io);
  assert.equal(code, 0, io.err);
  const lines = io.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'emit'));
  assert.ok(lines.some((l) => l.type === 'retractAlarm'));
  assert.ok(lines.every((l) => l.type === 'windowHash' || typeof l.cert === 'object'));
  const last = lines.at(-1);
  assert.equal(last.type, 'windowHash');
  assert.match(last.hash, /^[0-9a-f]{64}$/);
});

test('CLI exits 3 on non-integer ts', () => {
  withEvents(['{"upsert":{"id":"a","ts":1.5,"sym":"A"}}'], (eventsPath) => {
    const io = makeIo();
    assert.equal(run([eventsPath], io), 3);
    const err = JSON.parse(io.err.trim());
    assert.equal(err.type, 'error');
    assert.match(err.message, /ts must be an integer/);
  });
});

test('CLI exits 3 on window < 1', () => {
  withEvents(['{"setWindow":{"n":0}}'], (eventsPath) => {
    const io = makeIo();
    assert.equal(run([eventsPath], io), 3);
    assert.match(JSON.parse(io.err.trim()).message, /window size/);
  });
});

test('CLI exits 3 on duplicate retract', () => {
  withEvents(
    [
      '{"upsert":{"id":"a","ts":1,"sym":"A"}}',
      '{"retract":{"id":"a"}}',
      '{"retract":{"id":"a"}}',
    ],
    (eventsPath) => {
      const io = makeIo();
      assert.equal(run([eventsPath], io), 3);
      assert.match(JSON.parse(io.err.trim()).message, /unknown id/);
    },
  );
});

test('CLI exits 3 on retract of unknown id and on invalid JSON', () => {
  withEvents(['{"retract":{"id":"ghost"}}'], (eventsPath) => {
    assert.equal(run([eventsPath], makeIo()), 3);
  });
  withEvents(['{"upsert":'], (eventsPath) => {
    const io = makeIo();
    assert.equal(run([eventsPath], io), 3);
    assert.match(JSON.parse(io.err.trim()).message, /invalid JSON/);
  });
});

test('CLI exits 2 on usage errors', () => {
  assert.equal(run([], makeIo()), 2);
  assert.equal(run(['missing.jsonl'], makeIo()), 2);
});
