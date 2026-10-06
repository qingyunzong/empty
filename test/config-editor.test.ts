import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigDocument } from '../src/config-editor.js';

test('parses keys, values and comments', () => {
  const doc = ConfigDocument.parse(
    '# header\n' +
      '\n' +
      'host = example.com  # the server\n' +
      'port = 8080\n' +
      '; another comment\n' +
      'path = /a#b\n',
  );
  assert.deepEqual(doc.keys(), ['host', 'port', 'path']);
  assert.equal(doc.get('host'), 'example.com');
  assert.equal(doc.get('port'), '8080');
  assert.equal(doc.get('path'), '/a#b'); // '#' without preceding space stays in value
  assert.deepEqual(doc.comments(), ['# header', '# the server', '; another comment']);
  assert.deepEqual(doc.duplicates(), []);
});

test('set replaces only the value span, byte for byte', () => {
  const before = '# c\na = 1\nb = 2\n';
  const doc = ConfigDocument.parse(before);
  doc.set('a', '10');
  assert.equal(doc.toString(), '# c\na = 10\nb = 2\n');
});

test('set preserves surrounding whitespace and trailing comment', () => {
  const doc = ConfigDocument.parse('a   =   foo  # keep me\nb=2\n');
  doc.set('a', 'bar');
  assert.equal(doc.toString(), 'a   =   bar  # keep me\nb=2\n');
});

test('set handles empty values in both directions', () => {
  const doc = ConfigDocument.parse('a = \nb = x\n');
  doc.set('a', 'filled');
  doc.set('b', '');
  // only the value span is touched; surrounding bytes stay as they were
  assert.equal(doc.toString(), 'a = filled\nb = \n');
  assert.equal(doc.get('a'), 'filled');
  assert.equal(doc.get('b'), '');
});

test('every unmodified byte is preserved after set', () => {
  const before = '# top\nk1 = v1\n\nk2   =   v2  # note\nk3 = v3\n';
  const doc = ConfigDocument.parse(before);
  doc.set('k2', 'longer-value');
  const after = doc.toString();
  const spanStart = before.indexOf('v2');
  const spanEnd = spanStart + 'v2'.length;
  assert.equal(after.slice(0, spanStart), before.slice(0, spanStart));
  assert.equal(
    after.slice(spanStart + 'longer-value'.length),
    before.slice(spanEnd),
  );
  assert.equal(after.length - before.length, 'longer-value'.length - 'v2'.length);
});

test('set appends unknown keys, adding a newline when needed', () => {
  const doc = ConfigDocument.parse('a = 1');
  doc.set('b', '2');
  assert.equal(doc.toString(), 'a = 1\nb = 2\n');
});

test('set rejects values that would parse as comments or span lines', () => {
  const doc = ConfigDocument.parse('a = 1\n');
  assert.throws(() => doc.set('a', 'x # y'), /comment/);
  assert.throws(() => doc.set('a', '#hash'), /comment/);
  assert.throws(() => doc.set('a', 'x\ny'), /line breaks/);
  assert.equal(doc.toString(), 'a = 1\n');
});

test('duplicate keys reject all edits', () => {
  const doc = ConfigDocument.parse('a = 1\nb = 2\na = 3\n');
  assert.deepEqual(doc.duplicates(), ['a']);
  assert.throws(() => doc.set('b', '20'), /duplicate keys/);
  assert.throws(() => doc.set('c', '4'), /duplicate keys/);
  assert.throws(() => doc.reorder(['b', 'a']), /duplicate keys/);
  assert.equal(doc.toString(), 'a = 1\nb = 2\na = 3\n'); // untouched
});

test('reorder moves attached leading comments with their key', () => {
  const doc = ConfigDocument.parse(
    '# about a\n# more about a\na = 1\n\n# about b\nb = 2\n',
  );
  doc.reorder(['b', 'a']);
  assert.equal(
    doc.toString(),
    '# about b\nb = 2\n\n# about a\n# more about a\na = 1\n',
  );
});

test('trailing comments do not belong to the key and stay in place', () => {
  const doc = ConfigDocument.parse('a = 1  # first\nb = 2  # second\n');
  doc.reorder(['b', 'a']);
  assert.equal(doc.toString(), 'b = 2  # first\na = 1  # second\n');
});

test('blank lines and unattached comments stay in place during reorder', () => {
  const doc = ConfigDocument.parse('# standalone\n\na = 1\nb = 2\n');
  doc.reorder(['b', 'a']);
  assert.equal(doc.toString(), '# standalone\n\nb = 2\na = 1\n');
});

test('reorder requires a full permutation of keys', () => {
  const doc = ConfigDocument.parse('a = 1\nb = 2\n');
  assert.throws(() => doc.reorder(['a']), /permutation/);
  assert.throws(() => doc.reorder(['a', 'a']), /permutation/);
  assert.throws(() => doc.reorder(['a', 'c']), /permutation/);
  assert.equal(doc.toString(), 'a = 1\nb = 2\n');
});

test('result re-parses to the same values and comments after edits', () => {
  const doc = ConfigDocument.parse(
    '# header\nhost = example.com  # server\n\n# port docs\nport = 8080\n',
  );
  doc.set('host', 'example.org');
  doc.reorder(['port', 'host']);

  const reparsed = ConfigDocument.parse(doc.toString());
  assert.equal(reparsed.get('host'), 'example.org');
  assert.equal(reparsed.get('port'), '8080');
  assert.deepEqual(reparsed.keys(), ['port', 'host']);
  assert.deepEqual(
    [...reparsed.comments()].sort(),
    [...doc.comments()].sort(),
  );
  assert.equal(reparsed.comments().length, 3);
});

test('CRLF line endings are preserved', () => {
  const doc = ConfigDocument.parse('a = 1\r\nb = 2\r\n');
  doc.set('b', '3');
  assert.equal(doc.toString(), 'a = 1\r\nb = 3\r\n');
});

test('unrecognized lines are kept verbatim and never move', () => {
  const doc = ConfigDocument.parse('a = 1\nnot a config line\nb = 2\n');
  doc.reorder(['b', 'a']);
  assert.equal(doc.toString(), 'b = 2\nnot a config line\na = 1\n');
});
