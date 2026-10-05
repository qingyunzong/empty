/**
 * Randomized differential test: for many random small programs, the
 * swap-reduced exploration must agree with the uncompressed exploration on
 * the verdict and on the shortest error length, while never exploring more
 * transitions.
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { parseProgram } from '../src/parser';
import { exploreDpor } from '../src/dpor';
import { exploreFull } from '../src/full';
import { interleavingCount, totalInstrs } from '../src/explore';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProgram(rand: () => number, lockHeavy: boolean): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const int = (n: number) => Math.floor(rand() * n);
  const nThreads = 1 + int(3);
  const nMutexes = int(3); // 0..2 mutexes
  const lines: string[] = ['var x = 0', 'var y = 1'];
  for (let m = 0; m < nMutexes; m++) lines.push(`mutex m${m}`);
  for (let t = 0; t < nThreads; t++) {
    lines.push(`thread T${t}`);
    const regs: string[] = [];
    const nInstrs = 1 + int(6);
    for (let i = 0; i < nInstrs; i++) {
      const choices = lockHeavy
        ? ['lock', 'unlock', 'lock', 'read', 'write-c']
        : ['read', 'write-c', 'lock', 'unlock'];
      if (regs.length > 0) choices.push('write-r', 'assert-c', 'assert-r');
      switch (pick(choices)) {
        case 'read': {
          const reg = `r${regs.length}`;
          regs.push(reg);
          lines.push(`  read ${reg} ${pick(['x', 'y'])}`);
          break;
        }
        case 'write-c':
          lines.push(`  write ${pick(['x', 'y'])} ${int(3)}`);
          break;
        case 'write-r':
          lines.push(`  write ${pick(['x', 'y'])} ${pick(regs)}`);
          break;
        case 'lock':
          if (nMutexes > 0) lines.push(`  lock m${int(nMutexes)}`);
          else lines.push(`  write ${pick(['x', 'y'])} ${int(3)}`);
          break;
        case 'unlock':
          if (nMutexes > 0) lines.push(`  unlock m${int(nMutexes)}`);
          else lines.push(`  write ${pick(['x', 'y'])} ${int(3)}`);
          break;
        case 'assert-c':
          lines.push(`  assert ${pick(regs)} ${pick(['==', '!=', '<', '<=', '>', '>='])} ${int(3)}`);
          break;
        case 'assert-r':
          lines.push(`  assert ${pick(regs)} ${pick(['==', '!=', '<=', '>='])} ${pick(regs)}`);
          break;
      }
    }
    lines.push('end');
  }
  return lines.join('\n') + '\n';
}

function runDifferential(cases: number, lockHeavy: boolean, seedOffset: number): { unsafe: number; withLocks: number } {
  let unsafe = 0;
  let withLocks = 0;
  for (let seed = seedOffset; seed < seedOffset + cases; seed++) {
    const source = randomProgram(mulberry32(seed), lockHeavy);
    if (source.includes('lock')) withLocks++;
    const program = parseProgram(source);
    const por = exploreDpor(program);
    const full = exploreFull(program);
    equal(por.verdict, full.verdict, `verdict mismatch for seed ${seed}:\n${source}`);
    const porLen = por.shortestError === null ? null : por.shortestError.length;
    const fullLen = full.shortestError === null ? null : full.shortestError.length;
    equal(porLen, fullLen, `shortest error length mismatch for seed ${seed}:\n${source}`);
    // Compression bound: never more executions than raw interleavings.
    ok(BigInt(por.stats.executions!) <= interleavingCount(program),
      `POR executions exceed interleaving count for seed ${seed}:\n${source}`);
    ok(BigInt(por.stats.transitions) <= BigInt(totalInstrs(program)) * interleavingCount(program),
      `POR transitions exceed stateless bound for seed ${seed}:\n${source}`);
    if (por.verdict === 'UNSAFE') unsafe++;
  }
  return { unsafe, withLocks };
}

test('differential: 300 random programs, reduced vs full', () => {
  const { unsafe, withLocks } = runDifferential(300, false, 1);
  console.log(`    300 random programs: ${unsafe} unsafe, ${withLocks} with locks; all verdicts and shortest-error lengths agree`);
});

test('differential: 200 lock-heavy random programs, reduced vs full', () => {
  const { unsafe, withLocks } = runDifferential(200, true, 10001);
  console.log(`    200 lock-heavy programs: ${unsafe} unsafe, ${withLocks} with locks; all verdicts and shortest-error lengths agree`);
});
