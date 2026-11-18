import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from './harness.js';

const INTERLEAVING_OPS = [
  'reserve',
  'reserve',
  'commit',
  'reserve',
  'release',
] as const;

function* interleavings<T>(
  left: readonly T[],
  right: readonly T[],
): Generator<Array<{ side: 'a' | 'b'; op: T }>> {
  if (left.length === 0) {
    yield right.map((op) => ({ side: 'b' as const, op }));
    return;
  }
  if (right.length === 0) {
    yield left.map((op) => ({ side: 'a' as const, op }));
    return;
  }
  for (const rest of interleavings(left.slice(1), right)) {
    yield [{ side: 'a' as const, op: left[0] as T }, ...rest];
  }
  for (const rest of interleavings(left, right.slice(1))) {
    yield [{ side: 'b' as const, op: right[0] as T }, ...rest];
  }
}

test('exhaustive interleavings of two node request sequences match naive windows', () => {
  let count = 0;
  for (const sequence of interleavings(INTERLEAVING_OPS, INTERLEAVING_OPS)) {
    const harness = new Harness({
      quota: 4,
      windowMs: 10,
      reservationTtlMs: 6,
      nodeIds: ['a', 'b'],
      shardLimits: [2, 2],
    });
    for (const step of sequence) {
      if (step.op === 'reserve') {
        harness.reserve(step.side);
      } else if (step.op === 'commit') {
        harness.commit(step.side);
      } else {
        harness.release(step.side);
      }
    }
    harness.reconcile();
    count += 1;
  }
  assert.equal(count, 252);
});

const WORD_OPS = [
  'reserve:a',
  'reserve:b',
  'commit:a',
  'commit:b',
  'release:a',
  'release:b',
  'advance:1',
  'advance:4',
  'reconcile',
] as const;

function applyWord(harness: Harness, word: readonly string[]): void {
  for (const operation of word) {
    if (operation === 'reserve:a') {
      harness.reserve('a');
    } else if (operation === 'reserve:b') {
      harness.reserve('b');
    } else if (operation === 'commit:a') {
      harness.commit('a');
    } else if (operation === 'commit:b') {
      harness.commit('b');
    } else if (operation === 'release:a') {
      harness.release('a');
    } else if (operation === 'release:b') {
      harness.release('b');
    } else if (operation === 'advance:1') {
      harness.advance(1);
    } else if (operation === 'advance:4') {
      harness.advance(4);
    } else {
      harness.reconcile();
    }
  }
  harness.reconcile();
}

function wordOf(code: number, length: number): string[] {
  const word: string[] = [];
  let remaining = code;
  for (let index = 0; index < length; index += 1) {
    word.push(WORD_OPS[remaining % WORD_OPS.length] as string);
    remaining = Math.floor(remaining / WORD_OPS.length);
  }
  return word;
}

test('exhaustive operation words verify accepted set, remaining quota and conservation', () => {
  const length = Number(process.env.EXHAUSTIVE_DEPTH ?? 5);
  const total = WORD_OPS.length ** length;
  for (let code = 0; code < total; code += 1) {
    const word = wordOf(code, length);
    const harness = new Harness({
      quota: 4,
      windowMs: 8,
      reservationTtlMs: 5,
      nodeIds: ['a', 'b'],
      shardLimits: [2, 2],
    });
    try {
      applyWord(harness, word);
    } catch (error) {
      throw new Error(
        `word [${word.join(' ')}] failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
});

const SINGLE_OPS = [
  'reserve',
  'commit',
  'release',
  'advance:1',
  'advance:4',
  'reconcile',
] as const;

test('a single shard matches a global naive sliding window exactly', () => {
  const length = 5;
  const total = SINGLE_OPS.length ** length;
  for (let code = 0; code < total; code += 1) {
    const word: string[] = [];
    let remaining = code;
    for (let index = 0; index < length; index += 1) {
      word.push(SINGLE_OPS[remaining % SINGLE_OPS.length] as string);
      remaining = Math.floor(remaining / SINGLE_OPS.length);
    }

    const harness = new Harness({
      quota: 3,
      windowMs: 8,
      reservationTtlMs: 5,
      nodeIds: ['a'],
      shardLimits: [3],
    });
    try {
      for (const operation of word) {
        if (operation === 'reserve') {
          harness.reserve('a');
        } else if (operation === 'commit') {
          harness.commit('a');
        } else if (operation === 'release') {
          harness.release('a');
        } else if (operation === 'advance:1') {
          harness.advance(1);
        } else if (operation === 'advance:4') {
          harness.advance(4);
        } else {
          harness.reconcile();
        }
      }
      harness.reconcile();
    } catch (error) {
      throw new Error(
        `single-shard word [${word.join(' ')}] failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
});
