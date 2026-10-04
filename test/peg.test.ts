import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alt,
  cut,
  eof,
  eps,
  grammar,
  GrammarError,
  lit,
  opt,
  parse,
  ref,
  rep,
  seq,
  type ParseError,
  type ParseResult,
} from '../src/peg.js';

function expectOk(r: ParseResult): unknown {
  if (!r.ok) {
    assert.fail(`expected success, got error at pos ${r.error.pos}: ${r.error.expected.join(', ')}`);
  }
  return r.value;
}

function expectErr(r: ParseResult): ParseError {
  if (r.ok) assert.fail('expected parse failure');
  return r.error;
}

test('sequence matches parts in order and collects values', () => {
  const g = grammar({ S: seq(lit('a'), lit('b')) }, 'S');
  assert.deepEqual(expectOk(parse(g, 'ab')), ['a', 'b']);
});

test('sequence failure reports the failing position', () => {
  const g = grammar({ S: seq(lit('a'), lit('b')) }, 'S');
  assert.deepEqual(expectErr(parse(g, 'ac')), { pos: 1, expected: ['"b"'] });
});

test('choice is prioritized: first matching branch wins, no backtracking', () => {
  // The first branch matches "ab"; PEG never backtracks into the choice to
  // try the second branch, so the following lit('b') has nothing to match.
  const g = grammar({ S: seq(alt(lit('ab'), lit('a')), lit('b')) }, 'S');
  assert.deepEqual(expectErr(parse(g, 'ab')), { pos: 2, expected: ['"b"'] });
});

test('repetition collects matches and stops at first failure', () => {
  const g = grammar({ S: rep(lit('a')) }, 'S');
  assert.deepEqual(expectOk(parse(g, 'aaa')), ['a', 'a', 'a']);
  assert.deepEqual(expectErr(parse(g, 'aaab')), {
    pos: 3,
    expected: ['"a"', '<end of input>'],
  });
});

test('cut commits: failure after cut skips remaining alternatives', () => {
  const withCut = grammar(
    { S: alt(seq(lit('a'), cut(), lit('b')), seq(lit('a'), lit('c'))) },
    'S',
  );
  assert.deepEqual(expectErr(parse(withCut, 'ac')), { pos: 1, expected: ['"b"'] });

  const withoutCut = grammar(
    { S: alt(seq(lit('a'), lit('b')), seq(lit('a'), lit('c'))) },
    'S',
  );
  expectOk(parse(withoutCut, 'ac'));
});

test('cut is scoped to the nearest enclosing choice; outer choices still backtrack', () => {
  const g = grammar(
    {
      S: alt(
        alt(seq(lit('a'), cut(), lit('b')), lit('a')),
        seq(lit('a'), lit('c')),
      ),
    },
    'S',
  );
  assert.deepEqual(expectOk(parse(g, 'ac')), ['a', 'c']);
});

test('cut consumed inside a repetition body propagates through the repetition', () => {
  const withCut = grammar(
    { S: alt(seq(rep(seq(lit('a'), cut())), lit('b')), seq(lit('a'), lit('c'))) },
    'S',
  );
  // The repetition's own lit('a') also fails at the farthest position.
  assert.deepEqual(expectErr(parse(withCut, 'ac')), { pos: 1, expected: ['"a"', '"b"'] });

  const withoutCut = grammar(
    { S: alt(seq(rep(lit('a')), lit('b')), seq(lit('a'), lit('c'))) },
    'S',
  );
  expectOk(parse(withoutCut, 'ac'));
});

test('zero-consumption repetition is a grammar error', () => {
  const direct = grammar({ S: rep(eps()) }, 'S');
  assert.throws(
    () => parse(direct, ''),
    (e: unknown) => e instanceof GrammarError && /without consuming input/.test(e.message),
  );

  const nullable = grammar({ S: rep(opt(lit('a'))) }, 'S');
  assert.throws(() => parse(nullable, 'aa'), GrammarError);
});

test('grammar definition errors are reported', () => {
  assert.throws(() => lit(''), GrammarError);
  assert.throws(() => alt(), GrammarError);
  assert.throws(() => parse(grammar({ S: ref('missing') }, 'S'), ''), /undefined rule/);
  const leftRecursive = grammar({ S: ref('S') }, 'S');
  assert.throws(() => parse(leftRecursive, ''), /left recursion/);
});

test('farthest failure collects the expected set from all tried branches', () => {
  const g = grammar(
    { S: alt(seq(lit('a'), lit('b')), seq(lit('a'), lit('c')), lit('a')) },
    'S',
  );
  assert.deepEqual(expectErr(parse(g, 'ad')), {
    pos: 1,
    expected: ['"b"', '"c"', '<end of input>'],
  });
});

test('recursive rules parse nested structures', () => {
  const g = grammar(
    { E: alt(seq(lit('('), ref('E'), lit(')')), lit('a')) },
    'E',
  );
  expectOk(parse(g, '((a))'));
  assert.deepEqual(expectErr(parse(g, '((a)')), { pos: 4, expected: ['")"'] });
});

test('memoization preserves cut scope across cache hits', () => {
  // A consumes a cut that is unowned inside A; its nearest enclosing choice
  // is determined by the caller. A at position 0 is evaluated twice: the
  // first evaluation's cut is owned by the inner choice, the second is a
  // cache hit inside the outer choice and must replay the cut flag.
  // Without it, the failure of lit('b') would look ordinary and the
  // fallback branch seq(lit('a'), lit('c')) would wrongly match.
  const g = grammar(
    {
      A: seq(lit('a'), cut()),
      S: alt(
        seq(alt(ref('A'), eps()), lit('x')),
        seq(ref('A'), lit('b')),
        seq(lit('a'), lit('c')),
      ),
    },
    'S',
  );
  const memo = parse(g, 'ac', { memo: true });
  assert.deepEqual(expectErr(memo), { pos: 1, expected: ['"b"', '"x"'] });
  assert.ok(memo.stats.memoHits >= 1, 'expected the cache to be exercised');

  const noMemo = parse(g, 'ac', { memo: false });
  assert.deepEqual(expectErr(noMemo), expectErr(memo));

  expectOk(parse(g, 'ab', { memo: true }));
});

test('memoized farthest-failure contributions are replayed on cache hits', () => {
  // B is evaluated at position 0 twice; the second evaluation is a cache
  // hit and must still contribute its expected terminals to the report.
  const g = grammar(
    {
      B: seq(lit('a'), lit('b')),
      S: seq(
        alt(seq(ref('B'), lit('x')), eps()),
        alt(ref('B'), lit('z')),
      ),
    },
    'S',
  );
  const memo = parse(g, 'ac', { memo: true });
  const noMemo = parse(g, 'ac', { memo: false });
  assert.ok(memo.stats.memoHits >= 1, 'expected the cache to be exercised');
  const memoErr = expectErr(memo);
  assert.deepEqual(memoErr, expectErr(noMemo));
  assert.deepEqual(memoErr, { pos: 1, expected: ['"b"'] });
});

test('eof and opt combinators', () => {
  const g = grammar({ S: seq(opt(lit('a')), eof()) }, 'S');
  expectOk(parse(g, 'a'));
  expectOk(parse(g, ''));
  expectErr(parse(g, 'b'));
});
