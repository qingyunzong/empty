import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';

test('cli: full flow exits 0 and keeps snapshot isolation', () => {
  const { code, stdout } = runCli(JSON.stringify([
    { op: 'create', eventId: 'A', deviceId: 'd1', validAt: '2026-01-01T00:00:00Z', data: { status: 'alarm' } },
    { op: 'snapshot' },
    { op: 'correct', eventId: 'A', data: { status: 'reset' } },
    { op: 'get', eventId: 'A', snapshot: 'snap-1' },
    { op: 'get', eventId: 'A' },
    { op: 'range', deviceId: 'd1' },
  ]));
  assert.equal(code, 0);
  const results = JSON.parse(stdout);
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results[1].result.snapshot, 'snap-1');
  assert.equal(results[3].result.data.status, 'alarm'); // old snapshot
  assert.equal(results[4].result.data.status, 'reset'); // latest
  assert.deepEqual(results[5].result.map((e) => e.data.status), ['reset']);
});

test('cli: single command object returns a single result object', () => {
  const { code, stdout } = runCli(JSON.stringify({ op: 'create', eventId: 'A', deviceId: 'd1', validAt: 1 }));
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.result.eventId, 'A');
});

test('cli: store error (E_DUP) exits 1 and continues remaining commands', () => {
  const { code, stdout } = runCli(JSON.stringify([
    { op: 'create', eventId: 'A', deviceId: 'd1', validAt: 1 },
    { op: 'create', eventId: 'A', deviceId: 'd1', validAt: 2 },
    { op: 'delete', eventId: 'missing' },
    { op: 'range', deviceId: 'd1', from: 0, to: 10 },
  ]));
  assert.equal(code, 1);
  const results = JSON.parse(stdout);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, 'E_DUP');
  assert.equal(results[2].error.code, 'E_NOTFOUND');
  assert.equal(results[3].ok, true);
});

test('cli: invalid JSON exits 2', () => {
  const { code, stderr } = runCli('{not json');
  assert.equal(code, 2);
  assert.equal(JSON.parse(stderr).error.code, 'E_USAGE');
});

test('cli: unknown op exits 2', () => {
  assert.equal(runCli(JSON.stringify([{ op: 'bogus' }])).code, 2);
});

test('cli: unknown snapshot reference exits 2', () => {
  assert.equal(runCli(JSON.stringify([{ op: 'get', eventId: 'A', snapshot: 'snap-99' }])).code, 2);
});

test('cli: empty command list exits 0 with empty results', () => {
  const { code, stdout } = runCli('[]');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});
