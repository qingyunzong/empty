import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { maskJson, JsonMasker, JsonSyntaxError } from '../src/index.js';

test('masks a string field by JSON pointer, preserving surrounding bytes', () => {
  const input = '{ "user" : { "name" : "ann", "token" : "s3cr3t" }, "n":1 }';
  const out = maskJson(input, ['/user/token']);
  assert.equal(out, '{ "user" : { "name" : "ann", "token" : "***" }, "n":1 }');
});

test('masks nested pointers and array elements', () => {
  const input = '{"items":[{"secret":"a"},{"secret":"b"},{"keep":1}],"x":[10,20,30]}';
  const out = maskJson(input, ['/items/0/secret', '/items/1/secret', '/x/2']);
  assert.equal(out, '{"items":[{"secret":"***"},{"secret":"***"},{"keep":1}],"x":[10,20,"***"]}');
});

test('masks an entire object or array value as one span', () => {
  const input = '{"a":{"x":1,"y":[2,3]},"b":[true,null]}';
  assert.equal(maskJson(input, ['/a']), '{"a":"***","b":[true,null]}');
  assert.equal(maskJson(input, ['/b']), '{"a":{"x":1,"y":[2,3]},"b":"***"}');
});

test('empty pointer masks the whole document', () => {
  assert.equal(maskJson('{"a":1}', ['']), '"***"');
  assert.equal(maskJson('  [1, 2]  ', [''], 'null'), '  null  ');
});

test('number lexemes are preserved verbatim when not targeted', () => {
  const input = '{"a":1e2,"b":0.10,"c":-0.5E+10,"d":9007199254740993,"e":-0,"f":[1E-9, 0.0]}';
  assert.equal(maskJson(input, ['/nope']), input);
  assert.equal(maskJson(input, []), input);
});

test('masked numbers are replaced by the mask, others keep their lexeme', () => {
  const input = '{"a":1e2,"b":0.10}';
  assert.equal(maskJson(input, ['/a']), '{"a":"***","b":0.10}');
});

test('non-target string escapes and whitespace stay byte-identical', () => {
  const input = '{\n\t"a" : "x\\ny\\u0041",\r\n "b":\t"\\t\\"q\\""\n}';
  assert.equal(maskJson(input, ['/missing']), input);
  const masked = maskJson(input, ['/a']);
  assert.equal(masked, '{\n\t"a" : "***",\r\n "b":\t"\\t\\"q\\""\n}');
});

test('key order and duplicate-free documents pass through unchanged', () => {
  const input = '{"z":1,"a":{"y":2,"b":3},"m":[4,{"c":5}]}';
  assert.equal(maskJson(input, ['/a/x']), input);
});

test('pointer escapes ~0 and ~1 address keys with tilde and slash', () => {
  const input = '{"a/b":{"m~n":"secret","plain":1}}';
  assert.equal(maskJson(input, ['/a~1b/m~0n']), '{"a/b":{"m~n":"***","plain":1}}');
});

test('escaped key in document matches decoded pointer segment', () => {
  const input = '{"k\\u0065y":"secret","other":2}';
  assert.equal(maskJson(input, ['/key']), '{"k\\u0065y":"***","other":2}');
});

test('custom mask replaces the value span', () => {
  assert.equal(maskJson('{"a":"x"}', ['/a'], '"[REDACTED]"'), '{"a":"[REDACTED]"}');
  assert.equal(maskJson('{"a":"x"}', ['/a'], '0'), '{"a":0}');
  assert.equal(maskJson('{"a":"x"}', ['/a'], 'null'), '{"a":null}');
});

test('invalid mask text is rejected up front', () => {
  assert.throws(() => new JsonMasker({ pointers: [], mask: 'not json' }), JsonSyntaxError);
  assert.throws(() => new JsonMasker({ pointers: [], mask: '' }), JsonSyntaxError);
});

test('invalid pointers are rejected up front', () => {
  assert.throws(() => new JsonMasker({ pointers: ['a/b'] }), JsonSyntaxError);
  assert.throws(() => new JsonMasker({ pointers: ['/a~2b'] }), JsonSyntaxError);
});

test('unmatched pointers leave the document untouched', () => {
  const input = '{"a":[1,2,{"b":"c"}]}';
  assert.equal(maskJson(input, ['/a/3', '/a/2/c', '/q']), input);
});

test('masking an ancestor swallows descendant pointers', () => {
  const input = '{"a":{"b":{"c":"secret"}},"d":1}';
  assert.equal(maskJson(input, ['/a', '/a/b/c']), '{"a":"***","d":1}');
});
