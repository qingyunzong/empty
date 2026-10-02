import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { iso, freshDir } from './helpers.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through its exported run() — same argv parsing, same output.
async function wxa(dir, ...args) {
  let out = '';
  let err = '';
  const code = await run([...args, '--data', dir], {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
  });
  if (code !== 0) throw new Error(`wxa ${args[0]} exited ${code}: ${err}`);
  return JSON.parse(out);
}

test('CLI end-to-end: ingest, correct, query, undo, audit, verify', async () => {
  const dir = await freshDir();
  const obsFile = join(dir, 'obs.jsonl');
  await writeFile(
    obsFile,
    [
      { site: 'S1', time: iso(0), value: 10, quality: 'good' },
      { site: 'S1', time: iso(1), value: 20, quality: 'good' },
      { site: 'S1', time: iso(2), value: null, quality: 'good' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const batchFile = join(dir, 'batch.json');
  await writeFile(
    batchFile,
    JSON.stringify({
      batchId: 'fix-1',
      corrections: [
        { site: 'S1', time: iso(1), op: 'replace', value: 26, quality: 'suspect' },
        { site: 'S1', time: iso(0), op: 'flag', quality: 'unknown' },
      ],
    }),
  );

  const ing = await wxa(dir, 'ingest', obsFile, '--batch', 'load-1');
  assert.equal(ing.batchId, 'load-1');
  assert.equal(ing.count, 3);

  const cor = await wxa(dir, 'correct', batchFile);
  assert.equal(cor.batchId, 'fix-1');

  const q1 = await wxa(dir, 'query', 'S1', iso(0), iso(2));
  // t0 flagged unknown (w 0.5), t1 replaced 26 suspect (w 0.5), t2 null
  assert.equal(q1.mean, (10 * 0.5 + 26 * 0.5) / 1);
  assert.equal(q1.nullCount, 1);
  assert.equal(q1.confidence, 'unknown');

  const und = await wxa(dir, 'undo', 'fix-1');
  assert.equal(und.undone, 'fix-1');
  assert.equal(und.affectedKeys.length, 2);

  const q2 = await wxa(dir, 'query', 'S1', iso(0), iso(2));
  assert.equal(q2.mean, 15);
  assert.equal(q2.confidence, 'high');

  const audit = await wxa(dir, 'audit', `S1@${iso(1)}`);
  assert.equal(audit.current.value, 20);
  assert.equal(audit.history.length, 2);
  assert.equal(audit.rollbackBoundaries.length, 1);
  assert.equal(audit.rollbackBoundaries[0].batchId, 'fix-1');

  const verify = await wxa(dir, 'verify');
  assert.equal(verify.ok, true);

  const recovery = await wxa(dir, 'recover');
  assert.equal(recovery.action, 'verify-only');
});

test('CLI reports errors with non-zero exit', async () => {
  const dir = await freshDir();
  await assert.rejects(wxa(dir, 'undo', 'no-such-batch'), /unknown batch/);
  await assert.rejects(wxa(dir, 'audit', 'bad-key-without-at'), /site@time/);
});
