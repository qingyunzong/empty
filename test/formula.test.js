'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse, canonicalString, LexError, FormulaTypeError } = require('../lib/formula');
const { FormulaStore, StateError, UnknownNameError } = require('../lib/store');
const { run } = require('../cli');

// Drives the CLI command loop in-process: same parsing, output and exit-code
// path as `node cli.js < stdin`, without spawning a child process.
function runCli(input) {
  const out = [];
  const err = [];
  const status = run(input, (s) => out.push(s), (s) => err.push(s));
  return {
    status,
    stdout: out.length ? out.join('\n') + '\n' : '',
    stderr: err.length ? err.join('\n') + '\n' : '',
  };
}

test('acceptance 1: correct v=a/2[t], undo, redo — versions and certificates', () => {
  const store = new FormulaStore();
  assert.deepEqual(store.def('v', 'a/2'), { name: 'v', version: 1 });
  assert.deepEqual(store.correct('v', 'a/2[t]'), { name: 'v', version: 2 });

  const certV2 = store.certify('v');
  assert.equal(certV2.version, 2);
  assert.match(certV2.sha256, /^[0-9a-f]{64}$/);

  assert.deepEqual(store.undo('v'), { name: 'v', version: 1 });
  const certV1 = store.certify('v');
  assert.equal(certV1.version, 1);
  assert.notEqual(certV1.sha256, certV2.sha256);

  assert.deepEqual(store.redo('v'), { name: 'v', version: 2 });
  assert.deepEqual(store.certify('v'), certV2);

  // A new correction after undo clears the redo branch.
  store.undo('v');
  store.correct('v', 'a/2[m/s]');
  assert.equal(store.currentVersion('v'), 2);
  assert.throws(() => store.redo('v'), StateError);
});

test('acceptance 1 (cli): full session round-trip keeps certificates stable', () => {
  const res = runCli([
    'def v = a/2',
    'correct v = a/2[t]',
    'certify v',
    'undo v',
    'certify v',
    'redo v',
    'certify v',
    '',
  ].join('\n'));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.version), [1, 2, 2, 1, 1, 2, 2]);
  assert.equal(lines[2].sha256, lines[6].sha256);
  assert.notEqual(lines[2].sha256, lines[4].sha256);
});

function parenthesizations(tokens) {
  if (tokens.length === 1) return [tokens[0]];
  const results = [];
  for (let i = 1; i < tokens.length; i += 2) {
    for (const left of parenthesizations(tokens.slice(0, i))) {
      for (const right of parenthesizations(tokens.slice(i + 1))) {
        results.push(`(${left}${tokens[i]}${right})`);
      }
    }
  }
  return results;
}

test('acceptance 2: a+b*2 matches only a+(b*2) among all parenthesizations', () => {
  const tokens = ['a', '+', 'b', '*', '2'];
  const all = parenthesizations(tokens);
  assert.deepEqual(all.sort(), ['((a+b)*2)', '(a+(b*2))']);

  const bare = canonicalString(parse('a+b*2'));
  const matches = all.filter((p) => canonicalString(parse(p)) === bare);
  assert.deepEqual(matches, ['(a+(b*2))']);
});

test('acceptance 2: precedence chain across operators', () => {
  const cases = [
    ['a||b&&c', 'a||(b&&c)'],
    ['a&&b==c', 'a&&(b==c)'],
    ['a<b==c', '(a<b)==c'],
    ['a+b-c', '(a+b)-c'],
    ['a-b+c', '(a-b)+c'],
    ['a*b/c', '(a*b)/c'],
    ['a/b*c', '(a/b)*c'],
    ['-a*b', '(-a)*b'],
    ['-a+b', '(-a)+b'],
    ['a*-b', 'a*(-b)'],
    ['f(a)+b', 'f(a)+b'],
    ['f(a,b)*c', 'f(a,b)*c'],
    ['a||b&&c<d+e*f', 'a||(b&&(c<(d+(e*f))))'],
  ];
  for (const [bare, grouped] of cases) {
    assert.equal(canonicalString(parse(bare)), canonicalString(parse(grouped)), bare);
  }
  // Distinct groupings of the same tokens must not collapse.
  assert.notEqual(canonicalString(parse('a-b-c')), canonicalString(parse('a-(b-c)')));
  assert.notEqual(canonicalString(parse('a/(b/c)')), canonicalString(parse('a/b/c')));
});

test('acceptance 3: unclosed unit fragment errors and leaves state unchanged', () => {
  const store = new FormulaStore();
  store.def('x', 'a+1');
  const before = store.certify('x');
  assert.throws(() => store.correct('x', 'a/2[m/s'), LexError);
  assert.throws(() => store.correct('x', 'a/2[[ev-9]'), LexError);
  assert.equal(store.currentVersion('x'), 1);
  assert.deepEqual(store.certify('x'), before);
});

test('acceptance 3: redo on empty stack errors and leaves state unchanged', () => {
  const store = new FormulaStore();
  store.def('x', 'a+1');
  const before = store.certify('x');
  assert.throws(() => store.redo('x'), StateError);
  assert.equal(store.currentVersion('x'), 1);
  assert.deepEqual(store.certify('x'), before);
});

test('acceptance 3 (cli): lex error goes to stderr with exit 1 and no partial version', () => {
  const res = runCli('def x = a+1\ncorrect x = a/2[m/s\ncertify x\n');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^error: lex error: unclosed unit fragment/);
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ ok: true, name: 'x', version: 1 }]);
});

test('acceptance 3 (cli): redo on empty stack goes to stderr with exit 1', () => {
  const res = runCli('def x = a+1\nredo x\ncertify x\n');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^error: state error: 'x' has nothing to redo/);
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ ok: true, name: 'x', version: 1 }]);
});

test('lexer distinguishes expressions, unit fragments and evidence fragments', () => {
  assert.equal(
    canonicalString(parse('v[m/s] + w')),
    '["bin","+",["unit","m/s",["var","v"]],["var","w"]]',
  );
  assert.equal(
    canonicalString(parse('w[[ev-42]]')),
    '["evidence","ev-42",["var","w"]]',
  );
});

test('type and unknown-name errors', () => {
  assert.throws(() => parse('a + b[[e1]]'), FormulaTypeError);
  assert.throws(() => parse('-x[[e1]]'), FormulaTypeError);
  assert.throws(() => parse('[m/s]'), FormulaTypeError);
  const store = new FormulaStore();
  assert.throws(() => store.correct('nope', 'a+1'), UnknownNameError);
  assert.throws(() => store.undo('nope'), UnknownNameError);
  assert.throws(() => store.certify('nope'), UnknownNameError);
  const res = runCli('certify ghost\n');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^error: unknown name: 'ghost' is not defined/);
});

test('undo at the oldest version errors', () => {
  const store = new FormulaStore();
  store.def('x', '1');
  assert.throws(() => store.undo('x'), StateError);
  store.correct('x', '2');
  store.undo('x');
  assert.throws(() => store.undo('x'), StateError);
  assert.equal(store.currentVersion('x'), 1);
});
