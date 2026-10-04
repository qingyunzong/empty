import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';

const run = (input, argv = []) => {
  let stdout = '';
  let stderr = '';
  const code = runCli({
    argv,
    stdin: input,
    writeOut: (s) => (stdout += s),
    writeErr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
};

test('CLI outputs one JSON line with nets and certificate per event', () => {
  const input =
    [
      { type: 'submit', id: 'i1', version: 1, payer: 'A', payee: 'B', amountCents: 500 },
      { type: 'submit', id: 'i2', version: 1, payer: 'B', payee: 'C', amountCents: 200 },
      { type: 'revoke', id: 'i1' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  const res = run(input);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].nets, { A: -500, B: 500 });
  assert.deepEqual(lines[2].nets, { A: 0, B: -200, C: 200 });
  for (const line of lines) assert.match(line.certificate, /^[0-9a-f]{64}$/);
  assert.equal(lines[1].batchSeq, 2);
});

test('CLI exits 2 with stderr on a business error', () => {
  const input =
    JSON.stringify({ type: 'submit', id: 'i1', version: 1, payer: 'A', payee: 'B', amountCents: 5 }) +
    '\n' +
    JSON.stringify({ type: 'revoke', id: 'ghost' }) +
    '\n';
  const res = run(input);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error: UNKNOWN_INSTRUCTION/);
  assert.equal(res.stdout.trim().split('\n').length, 1);
});

test('CLI exits 2 on cyclic dependency', () => {
  const input =
    JSON.stringify({
      type: 'submit',
      id: 's',
      version: 1,
      payer: 'A',
      payee: 'B',
      amountCents: 5,
      dependsOn: ['s'],
    }) + '\n';
  const res = run(input);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error: (CYCLE|UNKNOWN_DEPENDENCY)/);
});

test('CLI exits 2 on invalid JSON', () => {
  const res = run('this is not json\n');
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error: PARSE/);
});
