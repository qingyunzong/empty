import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Executor, StageDef } from '../src/index.js';

function workspace(): { dir: string; cacheDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  return { dir, cacheDir: join(dir, 'cache') };
}

function countingStage(
  id: string,
  counters: Map<string, number>,
  deps: string[] = [],
  run?: () => unknown
): StageDef {
  return {
    id,
    deps,
    run: () => {
      counters.set(id, (counters.get(id) ?? 0) + 1);
      return run ? run() : `${id}-out`;
    },
  };
}

const ran = (counters: Map<string, number>, id: string): number => counters.get(id) ?? 0;

test('successful stages are reused on a second run', async () => {
  const { cacheDir } = workspace();
  const counters = new Map<string, number>();
  const stages = () => [
    countingStage('A', counters),
    countingStage('B', counters, ['A']),
    countingStage('C', counters, ['B']),
  ];

  const first = await new Executor(stages(), { cacheDir }).run();
  deepEqual(first.stages, { A: 'executed', B: 'executed', C: 'executed' });

  const second = await new Executor(stages(), { cacheDir }).run();
  deepEqual(second.stages, { A: 'reused', B: 'reused', C: 'reused' });
  equal(ran(counters, 'A'), 1);
  equal(ran(counters, 'B'), 1);
  equal(ran(counters, 'C'), 1);
});

test('a failure reruns only the failed stage and its successors', async () => {
  const { cacheDir } = workspace();
  const counters = new Map<string, number>();
  let bShouldFail = true;
  // Diamond: A -> B -> C, A -> D. B fails on the first run.
  const stages = () => [
    countingStage('A', counters),
    countingStage('B', counters, ['A'], () => {
      if (bShouldFail) throw new Error('B exploded');
      return 'B-out';
    }),
    countingStage('C', counters, ['B']),
    countingStage('D', counters, ['A']),
  ];

  const first = await new Executor(stages(), { cacheDir }).run();
  equal(first.ok, false);
  deepEqual(first.stages, { A: 'executed', B: 'failed', C: 'skipped', D: 'executed' });

  bShouldFail = false;
  const second = await new Executor(stages(), { cacheDir }).run();
  equal(second.ok, true);
  // A and D are reused from cache; only B and its successor C re-execute.
  deepEqual(second.stages, { A: 'reused', B: 'executed', C: 'executed', D: 'reused' });
  equal(ran(counters, 'A'), 1);
  equal(ran(counters, 'D'), 1);
  equal(ran(counters, 'B'), 2);
  equal(ran(counters, 'C'), 1);
});

test('editing an input file invalidates that stage and its successors only', async () => {
  const { dir, cacheDir } = workspace();
  const inputFile = join(dir, 'data.txt');
  writeFileSync(inputFile, 'v1');
  const counters = new Map<string, number>();
  const stages = (): StageDef[] => [
    {
      id: 'A',
      inputs: [inputFile],
      run: (ctx) => {
        counters.set('A', (counters.get('A') ?? 0) + 1);
        return `A:${ctx.inputs[inputFile]}`;
      },
    },
    countingStage('B', counters, ['A']),
    countingStage('C', counters), // independent branch
  ];

  const first = await new Executor(stages(), { cacheDir }).run();
  deepEqual(first.stages, { A: 'executed', B: 'executed', C: 'executed' });

  writeFileSync(inputFile, 'v2'); // file change while "powered off"
  const second = await new Executor(stages(), { cacheDir }).run();
  deepEqual(second.stages, { A: 'executed', B: 'executed', C: 'reused' });
  equal(ran(counters, 'A'), 2);
  equal(ran(counters, 'B'), 2);
  equal(ran(counters, 'C'), 1);
});

test('tampered cache records fail integrity checks and are not reused', async () => {
  const { cacheDir } = workspace();
  const counters = new Map<string, number>();
  const stages = () => [countingStage('A', counters), countingStage('B', counters, ['A'])];

  await new Executor(stages(), { cacheDir }).run();

  // Corrupt A's committed record in place (flip the value, keep the hash).
  const aFile = readdirSync(cacheDir).find((f) => f.startsWith('A-'))!;
  const record = JSON.parse(readFileSync(join(cacheDir, aFile), 'utf8'));
  record.value = 'forged-output';
  writeFileSync(join(cacheDir, aFile), JSON.stringify(record));

  const second = await new Executor(stages(), { cacheDir }).run();
  equal(second.stages['A'], 'executed'); // forgery rejected, stage re-ran
  equal(ran(counters, 'A'), 2);
});

test('leftover temp files are swept and never treated as cache hits', async () => {
  const { cacheDir } = workspace();
  const counters = new Map<string, number>();
  const stages = () => [countingStage('A', counters)];

  await new Executor(stages(), { cacheDir }).run();
  // Simulate debris from a killed publish.
  writeFileSync(join(cacheDir, 'A-deadbeef.json.tmp-999'), '{"stageId":"A"');

  const second = await new Executor(stages(), { cacheDir }).run();
  equal(second.stages['A'], 'reused'); // real record still hits
  equal(ran(counters, 'A'), 1);
  ok(!readdirSync(cacheDir).some((f) => f.includes('.tmp-')), 'tmp debris swept');
});
