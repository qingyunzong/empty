import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, ParseError } from '../src/parser.js';
import { compile, CompileError } from '../src/compiler.js';

test('pratt precedence: or < and < comparison', () => {
  const program = parseSource('query ancestors(LOT-2025-0001) where a == "x" or b == "y" and c == "z";');
  const filter = program.statements[0].filter;
  assert.equal(filter.op, 'OR');
  assert.equal(filter.left.op, 'EQEQ');
  assert.equal(filter.right.op, 'AND');
  assert.equal(filter.right.left.op, 'EQEQ');
  assert.equal(filter.right.right.op, 'EQEQ');
});

test('not binds tighter than and, looser than comparison', () => {
  const program = parseSource('query ancestors(LOT-2025-0001) where not a == "x" and b == "y";');
  const filter = program.statements[0].filter;
  assert.equal(filter.op, 'AND');
  assert.equal(filter.left.kind, 'unary');
  assert.equal(filter.left.operand.op, 'EQEQ');
});

test('parentheses override precedence', () => {
  const program = parseSource('query ancestors(LOT-2025-0001) where (a == "x" or b == "y") and c == "z";');
  const filter = program.statements[0].filter;
  assert.equal(filter.op, 'AND');
  assert.equal(filter.left.op, 'OR');
});

test('parse errors carry line numbers', () => {
  let caught;
  try {
    parseSource('query ancestors(LOT-2025-0001);\nquery ;');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParseError);
  assert.equal(caught.line, 2);
});

test('let variables have lexical scope: undefined reference is a compile error', () => {
  assert.throws(
    () => compile(parseSource('query missing;')),
    (err) => err instanceof CompileError && /undefined variable 'missing'/.test(err.message),
  );
});

test('redeclaring a let variable is a compile error', () => {
  assert.throws(
    () => compile(parseSource('let a = ancestors(LOT-2025-0001);\nlet a = ancestors(LOT-2025-0002);')),
    /already declared/,
  );
});

test('where clause on shortestPath is rejected at compile time', () => {
  assert.throws(
    () => compile(parseSource('query shortestPath(LOT-2025-0001, LOT-2025-0002) where type == "raw";')),
    /requires a node set/,
  );
});

test('unknown attribute in filter is a compile error', () => {
  assert.throws(
    () => compile(parseSource('query ancestors(LOT-2025-0001) where bogus == 1;')),
    /unknown attribute or variable 'bogus'/,
  );
});

test('wrong argument counts are compile errors', () => {
  assert.throws(
    () => compile(parseSource('query ancestors(LOT-2025-0001, LOT-2025-0002);')),
    /expects 1 argument/,
  );
  assert.throws(
    () => compile(parseSource('query shortestPath(LOT-2025-0001);')),
    /expects 2 argument/,
  );
});

test('compilation emits bytecode with slots for let variables', () => {
  const compiled = compile(parseSource('let up = ancestors(LOT-2025-0001);\nquery up where type == "raw";'));
  const ops = compiled.code.map((i) => i.op);
  assert.deepEqual(ops, ['PUSH', 'CALL', 'STORE', 'LOAD', 'FILTER', 'EMIT']);
  assert.equal(compiled.slots, 1);
});
