import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runCli } from '../src/cli.js';

test('CLI: reads JSONL stream, prints timeline/violations/queue/certificates', () => {
  const input = [
    '{"type":"config","pool":100,"cards":{"c1":200},"agingK":2,"preemptWindow":2}',
    '{"type":"auth","id":"low","card":"c1","amount":60,"priority":0,"slot":0,"expires":3}',
    '{"type":"auth","id":"vip","card":"c1","amount":100,"priority":5,"slot":1,"expires":9}',
    '{"type":"capture","id":"low","slot":3}',
  ].join('\n');
  const { output, exitCode } = runCli(input);
  assert.equal(exitCode, 2); // violations present
  assert.ok(Array.isArray(output.timeline));
  assert.ok(Array.isArray(output.violations));
  assert.ok(Array.isArray(output.queue));
  assert.ok(Array.isArray(output.certificates));
  assert.equal(output.certificatesOk, true);
  assert.deepEqual(
    output.timeline.map((t) => t.type),
    ['auth', 'preempt', 'auth']);
  assert.equal(output.violations[0].code, 'AUTH_EXPIRED');
});

test('CLI: flags override config line; exit code 2 on violations', () => {
  const { args } = parseArgs(['--pool', '50', '--card', 'c1:70']);
  const { output, exitCode } = runCli(
    '{"type":"auth","id":"a","card":"c1","amount":60,"priority":0,"slot":0,"expires":5}\n',
    args);
  assert.equal(exitCode, 2);
  assert.equal(output.violations[0].code, 'POOL_SHORT');
  assert.equal(output.queue[0].id, 'a');
});

test('CLI: clean run exits 0', () => {
  const { output, exitCode } = runCli(
    '{"type":"auth","id":"a","card":"c","amount":10,"priority":0,"slot":0,"expires":5}\n',
    { pool: 50 });
  assert.equal(exitCode, 0);
  assert.equal(output.violations.length, 0);
});
