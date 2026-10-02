'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FormulaError, FormulaStore, lex, parse, canonical, certificate,
} = require('../formula');
const { runSession } = require('../cli');

// Enumerate every full binary parenthesization of an alternating
// operand/operator token sequence, e.g. ['a','+','b','*','2'].
function* parenthesizations(tokens) {
  if (tokens.length === 1) { yield tokens[0]; return; }
  for (let i = 1; i < tokens.length; i += 2) {
    for (const l of parenthesizations(tokens.slice(0, i))) {
      for (const r of parenthesizations(tokens.slice(i + 1))) {
        yield `(${l}${tokens[i]}${r})`;
      }
    }
  }
}

test('acceptance 1: correct v=a/2[t], undo, redo — versions and certificates', () => {
  const s = new FormulaStore();
  assert.deepEqual(s.def('v', 'a/3[t]'), { name: 'v', version: 1 });
  const cert1 = s.certify('v');

  assert.deepEqual(s.correct('v', 'a/2[t]'), { name: 'v', version: 2 });
  const cert2 = s.certify('v');
  assert.equal(cert2.version, 2);
  assert.notEqual(cert1.sha256, cert2.sha256);
  // Certificate is exactly SHA-256 over name + version + canonical AST.
  assert.equal(cert2.sha256, certificate('v', 2, parse('a/2[t]')));

  assert.deepEqual(s.undo('v'), { name: 'v', version: 1 });
  assert.deepEqual(s.certify('v'), cert1);

  assert.deepEqual(s.redo('v'), { name: 'v', version: 2 });
  assert.deepEqual(s.certify('v'), cert2);

  // A new correction after undo clears the redo branch.
  s.undo('v');
  assert.deepEqual(s.correct('v', 'a/4[t]'), { name: 'v', version: 2 });
  assert.throws(() => s.redo('v'), (e) => e instanceof FormulaError && /nothing to redo/.test(e.message));
});

test('acceptance 1 (CLI session): same scenario through the command interface', () => {
  const r = runSession('def v = a/3[t]\ncorrect v = a/2[t]\ncertify v\nundo v\ncertify v\nredo v\ncertify v\n');
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.version), [1, 2, 2, 1, 1, 2, 2]);
  assert.match(lines[2].sha256, /^[0-9a-f]{64}$/);
  assert.equal(lines[6].sha256, lines[2].sha256); // redo restores version-2 certificate
  assert.notEqual(lines[4].sha256, lines[2].sha256); // undo exposes version-1 certificate
});

test('acceptance 2: a+b*2 matches exactly the parenthesization a+(b*2)', () => {
  const flat = canonical(parse('a+b*2'));
  const all = [...parenthesizations(['a', '+', 'b', '*', '2'])].sort();
  assert.deepEqual(all, ['((a+b)*2)', '(a+(b*2))']);
  const matches = all.filter((p) => canonical(parse(p)) === flat);
  assert.deepEqual(matches, ['(a+(b*2))']);
  assert.notEqual(flat, canonical(parse('(a+b)*2')));
});

test('acceptance 2 (larger): a+b*2-c matches exactly one of 5 parenthesizations', () => {
  const flat = canonical(parse('a+b*2-c'));
  const all = [...parenthesizations(['a', '+', 'b', '*', '2', '-', 'c'])];
  assert.equal(all.length, 5); // Catalan(3)
  const matches = all.filter((p) => canonical(parse(p)) === flat);
  assert.deepEqual(matches, ['((a+(b*2))-c)']);
});

test('precedence: ||, &&, comparisons, additive, multiplicative, unary, call', () => {
  assert.equal(canonical(parse('a||b&&c')), canonical(parse('a||(b&&c)')));
  assert.equal(canonical(parse('a&&b==c')), canonical(parse('a&&(b==c)')));
  assert.equal(canonical(parse('a<b+1')), canonical(parse('a<(b+1)')));
  assert.equal(canonical(parse('a-b-c')), canonical(parse('(a-b)-c')));
  assert.equal(canonical(parse('a/b*2')), canonical(parse('(a/b)*2')));
  assert.equal(canonical(parse('-a*b')), canonical(parse('(-a)*b')));
  assert.equal(canonical(parse('-a+2')), canonical(parse('(-a)+2')));
  assert.equal(canonical(parse('--a')), canonical(parse('-(-a)')));
  assert.equal(canonical(parse('sqrt(a+b)*2')), canonical(parse('(sqrt(a+b))*2')));
  assert.equal(canonical(parse('max(a,b-1)[m/s]')), 'unit(m/s,call(max,name(a),bin(-,name(b),num(1))))');
});

test('lexer: unit and evidence fragments are distinct token kinds', () => {
  const tokens = lex('a/2[t][[obs-7]]');
  assert.deepEqual(tokens.map((t) => t.t), ['ident', 'op', 'num', 'unit', 'evidence']);
  assert.equal(tokens[3].v, 't');
  assert.equal(tokens[4].v, 'obs-7');
  const ast = parse('a/2[t][[obs-7]]');
  assert.equal(ast.t, 'bin');
  assert.equal(ast.right.t, 'evidence');
  assert.equal(ast.right.expr.t, 'unit');
});

test('acceptance 3: unclosed unit fragment errors and leaves no partial version', () => {
  const s = new FormulaStore();
  assert.throws(
    () => s.def('u', 'a/2[t'),
    (e) => e instanceof FormulaError && e.kind === 'lex' && /unclosed unit/.test(e.message),
  );
  assert.equal(s.has('u'), false); // no partial version committed
  assert.throws(
    () => s.def('u', 'a[[obs-7'),
    (e) => e.kind === 'lex' && /unclosed evidence/.test(e.message),
  );
  assert.equal(s.has('u'), false);
});

test('acceptance 3: redo on empty redo stack errors and state is unchanged', () => {
  const s = new FormulaStore();
  s.def('w', 'x+1');
  const before = s.certify('w');
  assert.throws(() => s.redo('w'), (e) => e.kind === 'state' && /nothing to redo/.test(e.message));
  assert.deepEqual(s.certify('w'), before);
  assert.throws(() => s.undo('w'), (e) => e.kind === 'state' && /nothing to undo/.test(e.message));
  assert.deepEqual(s.certify('w'), before);
});

test('errors: unknown name, unknown function (type), bad arity (type)', () => {
  const s = new FormulaStore();
  assert.throws(() => s.correct('nope', '1+1'), (e) => e.kind === 'name' && /unknown formula/.test(e.message));
  assert.throws(() => s.undo('nope'), (e) => e.kind === 'name');
  assert.throws(() => s.certify('nope'), (e) => e.kind === 'name');
  assert.throws(() => s.def('f', 'nosuch(1)'), (e) => e.kind === 'type' && /unknown function/.test(e.message));
  assert.throws(() => s.def('f', 'sqrt(1,2)'), (e) => e.kind === 'type' && /expects 1/.test(e.message));
  assert.equal(s.has('f'), false);
});

test('CLI: lexical error goes to stderr with exit code 1, no stdout', () => {
  const r = runSession('def u = a/2[t\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: lex: unclosed unit fragment/);
  assert.equal(r.stdout, '');
});

test('CLI: unknown name error goes to stderr with exit code 1', () => {
  const r = runSession('certify nope\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: name: unknown formula "nope"/);
});

test('CLI: type error (unknown function) exits 1, failed def commits nothing', () => {
  const r = runSession('def a = 1+1\ndef b = nosuch(1)\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: type: unknown function "nosuch"/);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ ok: true, op: 'def', name: 'a', version: 1 }]);
});

test('CLI: redo on empty stack exits 1 and does not corrupt state', () => {
  const r = runSession('def w = x+1\nredo w\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: state: formula "w" has nothing to redo/);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ ok: true, op: 'def', name: 'w', version: 1 }]);
});
