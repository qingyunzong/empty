import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Config,
  deleteItem,
  getValue,
  parse,
  setScalar,
  toJS,
} from '../src/index';

test('set replaces only the scalar lexical span', () => {
  const before = 'server:\n  host: old\n  port: 8080 # main port\n';
  assert.equal(
    setScalar(before, ['server', 'host'], 'new'),
    'server:\n  host: new\n  port: 8080 # main port\n',
  );
  assert.equal(
    setScalar(before, ['server', 'port'], 9090),
    'server:\n  host: old\n  port: 9090 # main port\n',
  );
});

test('set keeps surrounding whitespace and comments byte-identical', () => {
  const before = [
    '# header comment',
    '',
    'a:   1    # tail a',
    '  # indented comment',
    'b: "quoted" # tail b',
    '',
    '# footer comment',
    '',
  ].join('\n');
  const after = setScalar(before, ['a'], 42);
  assert.equal(
    after,
    [
      '# header comment',
      '',
      'a:   42    # tail a',
      '  # indented comment',
      'b: "quoted" # tail b',
      '',
      '# footer comment',
      '',
    ].join('\n'),
  );
  const afterQuoted = setScalar(before, ['b'], 'plain');
  assert.equal(afterQuoted.split('\n')[4], 'b: plain # tail b');
});

test('set on missing path leaves text untouched', () => {
  const before = 'a: 1\nb:\n  c: 2\n';
  assert.equal(setScalar(before, ['nope'], 1), before);
  assert.equal(setScalar(before, ['b', 'nope'], 1), before);
  assert.equal(setScalar(before, ['a', 'deeper'], 1), before);
  assert.equal(setScalar(before, ['b', 'c', 'deeper'], 1), before);
});

test('set on non-scalar path throws', () => {
  assert.throws(() => setScalar('a:\n  b: 1\n', ['a'], 5), /not a scalar|target is a map/);
  assert.throws(() => setScalar('- 1\n- 2\n', [], 5), /target is a seq/);
});

test('set fills an empty value after the colon', () => {
  assert.equal(setScalar('a:\n', ['a'], 5), 'a: 5\n');
  assert.equal(setScalar('a: # keep\n', ['a'], 'x'), 'a: x # keep\n');
  assert.equal(setScalar('-\n- 2\n', [0], 'x'), '- x\n- 2\n');
});

test('set serializes values so they reparse to the same value', () => {
  const before = 'v: 0\n';
  const cases: Array<[unknown, string]> = [
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [-12, '-12'],
    [1.5, '1.5'],
    ['plain', 'plain'],
    ['hello world', '"hello world"'],
    ['true', '"true"'],
    ['123', '"123"'],
    ['null', '"null"'],
    ['a#b', '"a#b"'],
    ['x: y', '"x: y"'],
    ['', '""'],
  ];
  for (const [value, token] of cases) {
    const out = setScalar(before, ['v'], value);
    assert.equal(out, `v: ${token}\n`, `token for ${JSON.stringify(value)}`);
    assert.deepEqual(toJS(parse(out).root), { v: value });
  }
});

test('set inside sequences by index', () => {
  const before = 'items:\n  - a\n  - b # second\n  - c\n';
  assert.equal(
    setScalar(before, ['items', 1], 'x'),
    'items:\n  - a\n  - x # second\n  - c\n',
  );
});

test('delete removes the entry and moves its trailing comment to the previous item', () => {
  const before = 'a: 1\nb: 2 # gone\nc: 3\n';
  assert.equal(deleteItem(before, ['b']), 'a: 1  # gone\nc: 3\n');
});

test('delete of first entry drops its trailing comment', () => {
  const before = 'a: 1 # first\nb: 2\n';
  assert.equal(deleteItem(before, ['a']), 'b: 2\n');
});

test('delete removes a nested block and keeps surrounding trivia', () => {
  const before = 'top:\n  x: 1\n  y: 2\n# between\nnext: 3\n';
  assert.equal(deleteItem(before, ['top']), '# between\nnext: 3\n');
});

test('delete moves a key-line comment of a nested block to the previous item', () => {
  const before = 'a: 0\ntop: # cfg\n  x: 1\nz: 9\n';
  assert.equal(deleteItem(before, ['top']), 'a: 0  # cfg\nz: 9\n');
});

test('delete sequence item moves trailing comment to previous item', () => {
  const before = 'items:\n  - a\n  - b # second\n  - c\n';
  assert.equal(deleteItem(before, ['items', 1]), 'items:\n  - a  # second\n  - c\n');
});

test('delete on missing path leaves text untouched', () => {
  const before = 'a: 1\nb:\n  - x\n  - y\n';
  assert.equal(deleteItem(before, ['nope']), before);
  assert.equal(deleteItem(before, ['b', 5]), before);
  assert.equal(deleteItem(before, ['b', 'x']), before);
  assert.equal(deleteItem(before, ['a', 0]), before);
  assert.equal(deleteItem(before, []), before);
});

test('delete of last child leaves an empty (null) parent', () => {
  const before = 'a:\n  only: 1\nb: 2\n';
  const after = deleteItem(before, ['a', 'only']);
  assert.equal(after, 'a:\nb: 2\n');
  assert.deepEqual(toJS(parse(after).root), { a: null, b: 2 });
});

test('reparse after edits yields correct tree values', () => {
  let text = 'root:\n  name: old\n  tags:\n    - a # first\n    - b\n  limit: 3\n';
  text = setScalar(text, ['root', 'name'], 'new');
  text = setScalar(text, ['root', 'limit'], 10);
  text = deleteItem(text, ['root', 'tags', 0]);
  assert.deepEqual(toJS(parse(text).root), {
    root: { name: 'new', tags: ['b'], limit: 10 },
  });
  assert.equal(text, 'root:\n  name: new\n  tags:\n    - b\n  limit: 10\n');
});

test('CRLF line endings are preserved', () => {
  const before = 'a: 1\r\nb: 2 # c\r\n';
  assert.equal(setScalar(before, ['a'], 5), 'a: 5\r\nb: 2 # c\r\n');
  assert.equal(deleteItem(before, ['b']), 'a: 1  # c\r\n');
});

test('quoted keys and quoted scalars parse', () => {
  const doc = parse('"my key": \'it\'\'s\'\nother: "a # not comment"\n');
  assert.deepEqual(toJS(doc.root), { 'my key': "it's", other: 'a # not comment' });
});

test('getValue reads through maps and sequences', () => {
  const text = 'a:\n  - x\n  - 1\n';
  assert.equal(getValue(text, ['a', 0]), 'x');
  assert.equal(getValue(text, ['a', 1]), 1);
  assert.equal(getValue(text, ['missing']), undefined);
});

test('parse errors on unsupported constructs', () => {
  assert.throws(() => parse('a:\n   b: 1\n  c: 2\n'), /indentation/);
  assert.throws(() => parse('- k: 1\n'), /inline mappings/);
  assert.throws(() => parse('\ta: 1\n'), /tab indentation/);
});

test('Config class round-trips edits', () => {
  const cfg = Config.parse('a: 1 # keep\nb:\n  - x\n  - y # tail\n');
  assert.equal(cfg.get(['a']), 1);
  assert.equal(cfg.get(['nope']), undefined);
  assert.equal(cfg.set(['a'], 2), true);
  assert.equal(cfg.set(['nope'], 2), false);
  assert.equal(cfg.delete(['b', 1]), true);
  assert.equal(cfg.delete(['b', 7]), false);
  assert.equal(cfg.toString(), 'a: 2 # keep\nb:\n  - x  # tail\n');
  assert.deepEqual(cfg.toJS(), { a: 2, b: ['x'] });
});
