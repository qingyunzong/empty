import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Interpreter, toJS, Value } from '../src/interpreter';
import { BudgetExhaustedError, ParseError, ScriptRuntimeError } from '../src/errors';

function run(source: string, budget?: number): { interp: Interpreter; result: Value | undefined } {
  const interp = new Interpreter(budget === undefined ? {} : { budget });
  const result = interp.run(source);
  return { interp, result };
}

test('integers: arithmetic, precedence, comparison, logic', () => {
  const { interp } = run(`
    let a = 2 + 3 * 4;
    let b = (2 + 3) * 4;
    let c = 17 % 5;
    let d = 7 / 2;
    let e = -a;
    let f = 1 < 2 && 3 >= 3 || 0;
    let g = !0;
  `);
  assert.equal(interp.get('a'), 14);
  assert.equal(interp.get('b'), 20);
  assert.equal(interp.get('c'), 2);
  assert.equal(interp.get('d'), 3);
  assert.equal(interp.get('e'), -14);
  assert.equal(interp.get('f'), 1);
  assert.equal(interp.get('g'), 1);
});

test('lists: literals, indexing, concat, nesting', () => {
  const { interp } = run(`
    let xs = [1, 2, 3];
    let s = xs[0] + xs[2];
    let ys = xs + [4];
    let m = [[1, 2], [3, 4]];
    let v = m[1][0];
  `);
  assert.equal(interp.get('s'), 4);
  assert.deepEqual(toJS(interp.get('ys') as Value), [1, 2, 3, 4]);
  assert.equal(interp.get('v'), 3);
});

test('dicts: literals, string keys, nested access', () => {
  const { interp } = run(`
    let d = {"a": 1, "b": {"c": 2}};
    let x = d["a"];
    let y = d["b"]["c"];
  `);
  assert.equal(interp.get('x'), 1);
  assert.equal(interp.get('y'), 2);
});

test('index assignment is persistent: no aliasing leaks between variables', () => {
  const { interp } = run(`
    let a = [1, 2, 3];
    let b = a;
    a[0] = 99;
    let d = {"k": [1]};
    let e = d;
    d["k"][0] = 7;
  `);
  assert.deepEqual(toJS(interp.get('a') as Value), [99, 2, 3]);
  assert.deepEqual(toJS(interp.get('b') as Value), [1, 2, 3]);
  assert.deepEqual(toJS(interp.get('d') as Value), { k: [7] });
  assert.deepEqual(toJS(interp.get('e') as Value), { k: [1] });
});

test('while loops: iteration, break, continue', () => {
  const { interp } = run(`
    let i = 0;
    let sum = 0;
    while (i < 10) {
      i = i + 1;
      if (i == 3) { continue; }
      if (i == 8) { break; }
      sum = sum + i;
    }
  `);
  assert.equal(interp.get('i'), 8);
  assert.equal(interp.get('sum'), 1 + 2 + 4 + 5 + 6 + 7);
});

test('step counting: every evaluation is charged deterministically', () => {
  const { interp } = run('1 + 2;');
  assert.equal(interp.stepsUsed, 3); // binary node + two int literals
});

test('step counting: loop back-edges are charged', () => {
  const { interp } = run('while (0) { }');
  assert.equal(interp.stepsUsed, 2); // one back-edge + one condition evaluation
});

test('budget exhaustion stops infinite loops and reports usage', () => {
  const interp = new Interpreter({ budget: 100 });
  assert.throws(() => interp.run('while (1) { }'), BudgetExhaustedError);
  assert.equal(interp.stepsUsed, 100);
});

test('budget exhaustion preserves unclosed transaction state without publishing', () => {
  const interp = new Interpreter({ budget: 50 });
  assert.throws(
    () => interp.run('let x = 1; transaction { x = 2; let y = 3; while (1) { } }'),
    BudgetExhaustedError,
  );
  assert.equal(interp.get('x'), 1, 'published store must not see the uncommitted write');
  assert.equal(interp.get('y'), undefined);
  assert.equal(interp.txDepth, 1, 'unclosed transaction frame is preserved');
  const pending = interp.pendingWrites();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].get('x'), 2, 'uncommitted write is inspectable inside the frame');
  interp.abortUnclosed();
  assert.equal(interp.txDepth, 0);
  interp.refuel(100);
  interp.run('x = 42;');
  assert.equal(interp.get('x'), 42, 'interpreter stays usable after aborting unclosed state');
});

test('malicious deep nesting: 150 unclosed transactions leak no partial writes', () => {
  const DEPTH = 150;
  let src = 'let victim = 0;\n';
  for (let i = 0; i < DEPTH; i++) src += 'transaction {\n';
  src += 'victim = 999;\nlet leak = 1;\nwhile (1) { }\n';
  for (let i = 0; i < DEPTH; i++) src += '}\n';

  const interp = new Interpreter({ budget: 1000 });
  assert.throws(() => interp.run(src), BudgetExhaustedError);
  assert.equal(interp.stepsUsed, 1000);
  assert.equal(interp.get('victim'), 0, 'no partial modification reaches the published store');
  assert.equal(interp.get('leak'), undefined);
  assert.deepEqual(interp.globalNames(), ['victim']);
  assert.equal(interp.txDepth, DEPTH, 'all unclosed frames are preserved');
  const innermost = interp.pendingWrites()[DEPTH - 1];
  assert.equal(innermost.get('victim'), 999);
  assert.equal(innermost.get('leak'), 1);
  interp.abortUnclosed();
  assert.equal(interp.txDepth, 0);
});

test('transaction publishes writes only on normal exit', () => {
  const { interp } = run(`
    let x = 1;
    transaction {
      x = 2;
      let y = 10;
    }
  `);
  assert.equal(interp.get('x'), 2);
  assert.equal(interp.get('y'), 10);
});

test('nested transactions publish outward level by level', () => {
  const { interp } = run(`
    let x = 0;
    transaction {
      x = 1;
      transaction {
        x = 2;
        transaction { x = 3; }
      }
    }
  `);
  assert.equal(interp.get('x'), 3);
});

test('rollback discards only the innermost transaction', () => {
  const { interp } = run(`
    let a = 0;
    transaction {
      a = 1;
      transaction {
        a = 2;
        rollback;
      }
    }
  `);
  assert.equal(interp.get('a'), 1);
});

test('runtime error inside a transaction rolls its writes back', () => {
  const interp = new Interpreter();
  assert.throws(
    () => interp.run('let x = 1; transaction { x = 2; let y = 1 / 0; }'),
    ScriptRuntimeError,
  );
  assert.equal(interp.get('x'), 1);
  assert.equal(interp.txDepth, 0);
});

test('no host object access: calls and property access do not exist', () => {
  assert.throws(() => run('foo(1);'), ParseError);
  assert.throws(() => run('let a = [1]; a.length;'), ParseError);
  assert.throws(() => run('let x = process;'), ScriptRuntimeError); // bare identifier, undefined at eval
});

test('undefined variable and type errors are runtime errors', () => {
  assert.throws(() => run('let a = missing;'), ScriptRuntimeError);
  assert.throws(() => run('let a = [1] + 2;'), ScriptRuntimeError);
  assert.throws(() => run('let a = 1 / 0;'), ScriptRuntimeError);
  assert.throws(() => run('let a = 9007199254740991 + 1;'), ScriptRuntimeError);
});

test('pathological nesting is rejected by the parser, not by stack overflow', () => {
  const deep = 'let x = ' + '('.repeat(5000) + '1' + ')'.repeat(5000) + ';';
  assert.throws(() => run(deep), ParseError);
  const deepTx = 'transaction {'.repeat(5000) + '}'.repeat(5000);
  assert.throws(() => run(deepTx), ParseError);
});

test('deep equality for == on lists and dicts', () => {
  const { interp } = run(`
    let a = [1, [2, 3]] == [1, [2, 3]];
    let b = {"k": 1} == {"k": 2};
    let c = {"k": [1]} == {"k": [1]};
  `);
  assert.equal(interp.get('a'), 1);
  assert.equal(interp.get('b'), 0);
  assert.equal(interp.get('c'), 1);
});
