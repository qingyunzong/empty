import test from 'node:test';
import assert from 'node:assert/strict';
import { split, Splitter, SplitError, type Sentence } from '../src/splitter.ts';

function texts(sentences: Sentence[]): string[] {
  return sentences.map((s) => s.text);
}

function splitChunked(source: string, size: number): Sentence[] {
  const splitter = new Splitter();
  for (let i = 0; i < source.length; i += size) {
    splitter.write(source.slice(i, i + size));
  }
  return splitter.end();
}

function catchError(fn: () => unknown): SplitError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SplitError, 'expected a SplitError');
    return err;
  }
  assert.fail('expected split to throw');
}

test('splits on top-level semicolons and keeps spans', () => {
  const src = 'a=1; b=2;';
  const sentences = split(src);
  assert.deepEqual(texts(sentences), ['a=1;', ' b=2;']);
  assert.deepEqual(
    sentences.map((s) => [s.start, s.end]),
    [
      [0, 4],
      [4, 9],
    ],
  );
  for (const s of sentences) {
    assert.equal(src.slice(s.start, s.end), s.text);
  }
});

test('trailing sentence without semicolon keeps its span', () => {
  const src = 'a=1; b=2';
  assert.deepEqual(texts(split(src)), ['a=1;', ' b=2']);
});

test('empty and whitespace-only input yields no sentences', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('  \n '), []);
});

test('semicolons inside strings do not split', () => {
  const src = `const s = "a;b"; const t = 'c;d';`;
  assert.deepEqual(texts(split(src)), [`const s = "a;b";`, ` const t = 'c;d';`]);
});

test('escaped quotes inside strings', () => {
  const src = `const s = "a\\";b"; x;`;
  assert.deepEqual(texts(split(src)), [`const s = "a\\";b";`, ' x;']);
});

test('semicolons inside line comments do not split', () => {
  const src = '// a;b\nfoo; // c;d';
  assert.deepEqual(texts(split(src)), ['// a;b\nfoo;', ' // c;d']);
});

test('semicolons inside block comments do not split', () => {
  const src = '/* a;b */ foo; /* c;d */';
  assert.deepEqual(texts(split(src)), ['/* a;b */ foo;', ' /* c;d */']);
});

test('semicolons inside template literals do not split', () => {
  const src = 'const t = `a;b`; x;';
  assert.deepEqual(texts(split(src)), ['const t = `a;b`;', ' x;']);
});

test('semicolons inside template interpolation do not split', () => {
  const src = 'const t = `a${ x; y }b`; z;';
  assert.deepEqual(texts(split(src)), ['const t = `a${ x; y }b`;', ' z;']);
});

test('template interpolation supports nested parens and braces', () => {
  const src = '`a${f(1;2, {g: (3;4)})}b`; tail;';
  assert.deepEqual(texts(split(src)), ['`a${f(1;2, {g: (3;4)})}b`;', ' tail;']);
});

test('nested template literals inside interpolation', () => {
  const src = '`a${ `b${c;d}e` }f`; g;';
  assert.deepEqual(texts(split(src)), ['`a${ `b${c;d}e` }f`;', ' g;']);
});

test('semicolons inside top-level parens do not split', () => {
  const src = 'f(a;b); g;';
  assert.deepEqual(texts(split(src)), ['f(a;b);', ' g;']);
});

test('unclosed string reports opening position', () => {
  const src = 'x=1; const s = "abc;';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'string');
  assert.equal(err.position, src.indexOf('"'));
});

test('unclosed template reports opening position', () => {
  const src = 'a; `bc';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'template');
  assert.equal(err.position, src.indexOf('`'));
});

test('unclosed interpolation leaves the template unclosed at its backtick', () => {
  const src = '`a${b`';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'template');
  assert.equal(err.position, src.indexOf('`'));
});

test('unclosed block comment reports opening position', () => {
  const src = 'a; /* x;y';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'blockComment');
  assert.equal(err.position, src.indexOf('/*'));
});

test('unclosed bracket reports opening position', () => {
  const src = 'f(a;';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'bracket');
  assert.equal(err.position, src.indexOf('('));
});

test('reports the earliest unclosed structure', () => {
  const src = '/* x " y';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'blockComment');
  assert.equal(err.position, 0);

  const src2 = '( "abc';
  const err2 = catchError(() => split(src2));
  assert.equal(err2.kind, 'bracket');
  assert.equal(err2.position, 0);
});

test('mismatched closing bracket reports its position', () => {
  const src = 'f(a];';
  const err = catchError(() => split(src));
  assert.equal(err.kind, 'mismatch');
  assert.equal(err.position, src.indexOf(']'));
});

const COMPLEX = [
  'const a = "x;y"; // c;d',
  '/* b;c */ const t = `p${f(1;2, {g: `h${3;4}i`})}q`;',
  'foo(bar(1;2), [3;4]);',
  'if (a) { b; } else { c; }',
  'tail',
].join('\n');

test('char-by-char chunked parsing matches whole-string parsing', () => {
  const whole = split(COMPLEX);
  assert.deepEqual(splitChunked(COMPLEX, 1), whole);
});

test('various chunk sizes match whole-string parsing', () => {
  const whole = split(COMPLEX);
  for (const size of [2, 3, 5, 7, 13, 64]) {
    assert.deepEqual(splitChunked(COMPLEX, size), whole, `chunk size ${size}`);
  }
});

test('chunked parsing reports the same unclosed error', () => {
  const src = 'a; const s = "x;y';
  const whole = catchError(() => split(src));
  const chunked = catchError(() => splitChunked(src, 1));
  assert.equal(chunked.kind, whole.kind);
  assert.equal(chunked.position, whole.position);
});

test('chunk boundary inside tokens (comment opener, interpolation, escape)', () => {
  const src = 'a/ /b; x/* c;d */y; `p${q;r}s`; "e\\";f"; z;';
  const whole = split(src);
  for (const size of [1, 2, 3]) {
    assert.deepEqual(splitChunked(src, size), whole, `chunk size ${size}`);
  }
  assert.deepEqual(texts(whole), ['a/ /b;', ' x/* c;d */y;', ' `p${q;r}s`;', ' "e\\";f";', ' z;']);
});
