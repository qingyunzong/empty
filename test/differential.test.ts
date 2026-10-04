import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alt,
  cut,
  eps,
  grammar,
  GrammarError,
  lit,
  opt,
  parse,
  ref,
  rep,
  seq,
  type Grammar,
  type Parser,
} from '../src/peg.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('unreachable');
  return item;
}

const LITERALS = ['a', 'b', 'c', 'ab', 'bc'] as const;

function randomParser(rng: () => number, ruleNames: readonly string[], depth: number): Parser {
  const kinds = depth <= 0
    ? ['lit', 'lit', 'lit', 'eps']
    : ['lit', 'lit', 'seq', 'alt', 'rep', 'opt', 'cut', 'eps', ...(ruleNames.length > 0 ? ['ref', 'ref'] : [])];
  const kind = pick(rng, kinds);
  switch (kind) {
    case 'lit':
      return lit(pick(rng, LITERALS));
    case 'eps':
      return eps();
    case 'cut':
      return cut();
    case 'seq':
      return seq(
        randomParser(rng, ruleNames, depth - 1),
        randomParser(rng, ruleNames, depth - 1),
      );
    case 'alt':
      return alt(
        randomParser(rng, ruleNames, depth - 1),
        randomParser(rng, ruleNames, depth - 1),
      );
    case 'rep':
      return rep(randomParser(rng, ruleNames, depth - 1));
    case 'opt':
      return opt(randomParser(rng, ruleNames, depth - 1));
    case 'ref':
      return ref(pick(rng, ruleNames));
    default:
      throw new Error('unreachable');
  }
}

function randomGrammar(rng: () => number): Grammar {
  const ruleCount = 1 + Math.floor(rng() * 4);
  const rules: Record<string, Parser> = {};
  const names: string[] = [];
  for (let i = 0; i < ruleCount; i += 1) {
    const name = `R${i}`;
    // Rules may only reference earlier rules, keeping the random grammars
    // free of recursion.
    rules[name] = randomParser(rng, names, 3);
    names.push(name);
  }
  const start = names[names.length - 1];
  if (start === undefined) throw new Error('unreachable');
  return grammar(rules, start);
}

function randomInput(rng: () => number, alphabet: string, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }
  | { readonly threw: string };

function run(g: Grammar, input: string, memo: boolean): { outcome: Outcome; hits: number } {
  try {
    const r = parse(g, input, { memo });
    return {
      outcome: r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error },
      hits: r.stats.memoHits,
    };
  } catch (e) {
    if (e instanceof GrammarError) return { outcome: { threw: e.message }, hits: 0 };
    throw e;
  }
}

function assertSameBehavior(g: Grammar, input: string): number {
  const memo = run(g, input, true);
  const noMemo = run(g, input, false);
  assert.deepEqual(
    memo.outcome,
    noMemo.outcome,
    `memoized and uncached interpreters disagree on input ${JSON.stringify(input)}`,
  );
  return memo.hits;
}

test('differential: memoized vs uncached interpreter on random grammars', () => {
  const rng = mulberry32(0x5eed);
  let totalHits = 0;
  let cases = 0;
  for (let i = 0; i < 400; i += 1) {
    const g = randomGrammar(rng);
    for (let j = 0; j < 8; j += 1) {
      totalHits += assertSameBehavior(g, randomInput(rng, 'abc', 8));
      cases += 1;
    }
  }
  assert.equal(cases, 3200);
  assert.ok(totalHits > 0, 'expected the memo cache to be exercised');
});

test('differential: hand-written grammars with cuts and recursion', () => {
  // Expression grammar using cut to commit after operators and '('.
  const expr = grammar(
    {
      E: alt(seq(ref('T'), lit('+'), cut(), ref('E')), ref('T')),
      T: alt(seq(ref('F'), lit('*'), cut(), ref('T')), ref('F')),
      F: alt(seq(lit('('), cut(), ref('E'), lit(')')), lit('a'), lit('b')),
    },
    'E',
  );
  // Cut whose owning choice is determined dynamically by the caller.
  const dynamicCut = grammar(
    {
      A: seq(lit('a'), cut()),
      S: seq(
        alt(ref('A'), eps()),
        alt(seq(ref('A'), lit('b')), seq(lit('a'), lit('c'))),
      ),
    },
    'S',
  );
  // Cut propagating out of a repetition body.
  const cutThroughRep = grammar(
    { S: alt(seq(rep(seq(lit('a'), cut())), lit('b')), seq(lit('a'), lit('c'))) },
    'S',
  );
  // Left-recursive and zero-consumption grammars must fail identically.
  const leftRecursive = grammar({ S: ref('S') }, 'S');
  const zeroConsumption = grammar({ S: rep(opt(lit('a'))) }, 'S');
  const grammars = [expr, dynamicCut, cutThroughRep, leftRecursive, zeroConsumption];
  const rng = mulberry32(0xc0ffee);
  let totalHits = 0;
  for (const g of grammars) {
    for (let i = 0; i < 400; i += 1) {
      totalHits += assertSameBehavior(g, randomInput(rng, 'abc()+*', 10));
    }
  }
  assert.ok(totalHits > 0, 'expected the memo cache to be exercised');
});
