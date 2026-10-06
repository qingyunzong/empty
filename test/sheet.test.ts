import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spreadsheet, Value } from '../src/sheet';
import { Expr, collectRefs, parseFormula } from '../src/parser';

function num(sheet: Spreadsheet, ref: string): number {
  const v = sheet.get(ref);
  assert.ok(v.ok, `expected ${ref} to be a number, got ${JSON.stringify(v)}`);
  return (v as { ok: true; value: number }).value;
}

function errType(sheet: Spreadsheet, ref: string): string {
  const v = sheet.get(ref);
  assert.ok(!v.ok, `expected ${ref} to be an error, got ${JSON.stringify(v)}`);
  return (v as { ok: false; error: { type: string } }).error.type;
}

test('integer arithmetic: precedence, parentheses, unary minus, truncating division', () => {
  const s = new Spreadsheet();
  s.set('A1', 5);
  s.set('A2', '=A1*2+3');
  s.set('A3', '=2+3*4');
  s.set('A4', '=(2+3)*4');
  s.set('A5', '=-(A1-8)');
  s.set('A6', '=7/2');
  s.set('A7', '=-7/2');
  s.set('A8', '=7/-2');
  assert.equal(num(s, 'A2'), 13);
  assert.equal(num(s, 'A3'), 14);
  assert.equal(num(s, 'A4'), 20);
  assert.equal(num(s, 'A5'), 3);
  assert.equal(num(s, 'A6'), 3);
  assert.equal(num(s, 'A7'), -3);
  assert.equal(num(s, 'A8'), -3);
});

test('references propagate updates through chains', () => {
  const s = new Spreadsheet();
  s.set('A1', 1);
  s.set('B1', '=A1+1');
  s.set('C1', '=B1*10');
  assert.equal(num(s, 'C1'), 20);
  s.set('A1', 5);
  assert.equal(num(s, 'B1'), 6);
  assert.equal(num(s, 'C1'), 60);
  assert.deepEqual(s.dependenciesOf('C1'), ['B1']);
  assert.deepEqual(s.dependentsOf('A1'), ['B1']);
});

test('IF only tracks dependencies of the executed branch', () => {
  const s = new Spreadsheet();
  s.set('A1', 1);
  s.set('C1', 10);
  s.set('D1', 20);
  s.set('B1', '=IF(A1,C1,D1)');
  assert.equal(num(s, 'B1'), 10);
  assert.deepEqual(s.dependenciesOf('B1'), ['A1', 'C1']);

  s.set('D1', 99);
  assert.equal(num(s, 'B1'), 10);

  s.set('A1', 0);
  assert.equal(num(s, 'B1'), 99);
  assert.deepEqual(s.dependenciesOf('B1'), ['A1', 'D1']);

  s.set('C1', 12345);
  assert.equal(num(s, 'B1'), 99);
});

test('errors in the non-taken IF branch do not propagate', () => {
  const s = new Spreadsheet();
  s.set('A1', 1);
  s.set('C1', 7);
  s.set('D1', '=1/0');
  s.set('B1', '=IF(A1,C1,D1)');
  assert.equal(num(s, 'B1'), 7);
  s.set('A1', 0);
  assert.equal(errType(s, 'B1'), 'div-by-zero');
});

test('dependencies are re-tracked after a formula is modified', () => {
  const s = new Spreadsheet();
  s.set('C1', 1);
  s.set('D1', 2);
  s.set('B1', '=C1');
  assert.equal(num(s, 'B1'), 1);
  assert.deepEqual(s.dependenciesOf('B1'), ['C1']);

  s.set('B1', '=D1*2');
  assert.equal(num(s, 'B1'), 4);
  assert.deepEqual(s.dependenciesOf('B1'), ['D1']);
  assert.deepEqual(s.dependentsOf('C1'), []);

  s.set('C1', 100);
  assert.equal(num(s, 'B1'), 4);
  s.set('D1', 5);
  assert.equal(num(s, 'B1'), 10);
});

test('cycles report the access path and can be broken', () => {
  const s = new Spreadsheet();
  s.set('A1', '=B1+1');
  s.set('B1', '=A1+1');
  s.set('C1', '=A1*2');

  const v = s.get('A1');
  assert.ok(!v.ok);
  if (v.ok) return;
  assert.equal(v.error.type, 'cycle');
  if (v.error.type !== 'cycle') return;
  assert.deepEqual(v.error.path, ['A1', 'B1', 'A1']);

  assert.equal(errType(s, 'B1'), 'cycle');
  assert.equal(errType(s, 'C1'), 'cycle');

  s.set('B1', 5);
  assert.equal(num(s, 'A1'), 6);
  assert.equal(num(s, 'C1'), 12);
});

test('self reference is a cycle of length one', () => {
  const s = new Spreadsheet();
  s.set('A1', '=A1+1');
  const v = s.get('A1');
  assert.ok(!v.ok);
  if (!v.ok && v.error.type === 'cycle') {
    assert.deepEqual(v.error.path, ['A1', 'A1']);
  } else {
    assert.fail('expected cycle error');
  }
});

test('division by zero replaces old values instead of leaking them', () => {
  const s = new Spreadsheet();
  s.set('A1', 10);
  s.set('B1', '=A1*2');
  s.set('C1', '=B1+1');
  assert.equal(num(s, 'C1'), 21);

  s.set('A1', '=1/0');
  assert.equal(errType(s, 'A1'), 'div-by-zero');
  assert.equal(errType(s, 'B1'), 'div-by-zero');
  assert.equal(errType(s, 'C1'), 'div-by-zero');

  s.set('A1', 4);
  assert.equal(num(s, 'B1'), 8);
  assert.equal(num(s, 'C1'), 9);
});

test('parse errors become cell errors and propagate to dependents', () => {
  const s = new Spreadsheet();
  s.set('A1', '=1+');
  s.set('B1', '=A1*2');
  assert.equal(errType(s, 'A1'), 'parse');
  assert.equal(errType(s, 'B1'), 'parse');
  s.set('A1', '=2');
  assert.equal(num(s, 'B1'), 4);
});

test('transaction rollback restores formulas, dependencies and values', () => {
  const s = new Spreadsheet();
  s.set('A1', 1);
  s.set('B1', '=A1+1');
  assert.equal(num(s, 'B1'), 2);

  s.begin();
  s.set('A1', 100);
  s.set('B1', '=A1*2');
  s.set('C1', '=B1');
  assert.equal(num(s, 'B1'), 200);
  assert.equal(num(s, 'C1'), 200);

  s.rollback();
  assert.equal(s.formulaOf('B1'), '=A1+1');
  assert.equal(num(s, 'B1'), 2);
  assert.equal(num(s, 'A1'), 1);
  assert.deepEqual(s.dependenciesOf('B1'), ['A1']);
  assert.equal(num(s, 'C1'), 0);

  s.set('A1', 5);
  assert.equal(num(s, 'B1'), 6);
});

test('transaction commit keeps changes; nested transactions unwind in order', () => {
  const s = new Spreadsheet();
  s.set('A1', 1);
  s.begin();
  s.set('A1', 2);
  s.begin();
  s.set('A1', 3);
  s.rollback();
  assert.equal(num(s, 'A1'), 2);
  s.commit();
  assert.equal(num(s, 'A1'), 2);
  assert.throws(() => s.rollback());
  assert.throws(() => s.commit());
});

// ---------- naive full-sheet oracle ----------

type Model = Map<string, number | string>;

interface OracleResult {
  value: Value;
  deps: Set<string>;
}

function oracleCell(model: Model, startRef: string): OracleResult {
  const visiting: string[] = [];
  const depStack: Set<string>[] = [];
  let rootDeps = new Set<string>();

  class Cycle extends Error {
    constructor(public path: string[]) {
      super('cycle');
    }
  }
  class Fail extends Error {
    constructor(public cellError: { type: string; message?: string }) {
      super('fail');
    }
  }

  function evalExpr(expr: Expr): number {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'ref':
        depStack[depStack.length - 1].add(expr.ref);
        return walk(expr.ref);
      case 'neg':
        return -evalExpr(expr.operand);
      case 'bin': {
        const l = evalExpr(expr.left);
        const r = evalExpr(expr.right);
        if (expr.op === '+') return l + r;
        if (expr.op === '-') return l - r;
        if (expr.op === '*') return l * r;
        if (r === 0) throw new Fail({ type: 'div-by-zero' });
        return Math.trunc(l / r);
      }
      case 'if':
        return evalExpr(expr.cond) !== 0 ? evalExpr(expr.thenBranch) : evalExpr(expr.elseBranch);
    }
  }

  function walk(ref: string): number {
    const idx = visiting.indexOf(ref);
    if (idx >= 0) throw new Cycle([...visiting.slice(idx), ref]);
    const entry = model.get(ref);
    const frame = new Set<string>();
    if (depStack.length === 0) rootDeps = frame;
    depStack.push(frame);
    visiting.push(ref);
    try {
      if (entry === undefined) return 0;
      if (typeof entry === 'number') return entry;
      const text = entry.startsWith('=') ? entry.slice(1) : entry;
      let ast: Expr;
      try {
        ast = parseFormula(text);
      } catch (e) {
        throw new Fail({ type: 'parse', message: (e as Error).message });
      }
      return evalExpr(ast);
    } finally {
      depStack.pop();
      visiting.pop();
    }
  }

  try {
    const n = walk(startRef);
    return { value: { ok: true, value: n === 0 ? 0 : n }, deps: rootDeps };
  } catch (e) {
    if (e instanceof Cycle) return { value: { ok: false, error: { type: 'cycle', path: e.path } }, deps: rootDeps };
    if (e instanceof Fail) {
      if (e.cellError.type === 'parse') {
        return { value: { ok: false, error: { type: 'parse', message: e.cellError.message ?? '' } }, deps: rootDeps };
      }
      return { value: { ok: false, error: { type: 'div-by-zero' } }, deps: rootDeps };
    }
    throw e;
  }
}

function assertValueMatches(sheetValue: Value, oracleValue: Value, model: Model, ctx: string): void {
  if (oracleValue.ok) {
    assert.ok(sheetValue.ok, `${ctx}: expected ${oracleValue.value}, got ${JSON.stringify(sheetValue)}`);
    assert.equal((sheetValue as { ok: true; value: number }).value, oracleValue.value, ctx);
    return;
  }
  assert.ok(!sheetValue.ok, `${ctx}: expected error, got ${JSON.stringify(sheetValue)}`);
  const sErr = (sheetValue as { ok: false; error: { type: string } }).error;
  const oErr = (oracleValue as { ok: false; error: { type: string } }).error;
  assert.equal(sErr.type, oErr.type, ctx);
  if (sErr.type === 'cycle') {
    const path = (sErr as { type: 'cycle'; path: string[] }).path;
    assert.ok(path.length >= 2, `${ctx}: cycle path too short`);
    assert.equal(path[0], path[path.length - 1], `${ctx}: cycle path must be closed`);
    for (let i = 0; i + 1 < path.length; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      const entry = model.get(from);
      assert.equal(typeof entry, 'string', `${ctx}: ${from} in cycle path must be a formula`);
      const refs = collectRefs(parseFormula((entry as string).replace(/^=/, '')));
      assert.ok(refs.has(to), `${ctx}: ${from} does not reference ${to}`);
    }
  }
}

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

for (const seed of [20261007, 7, 42, 1337, 987654321]) {
  test(`incremental engine matches naive full-sheet evaluation (seed ${seed})`, () => {
  const rand = mulberry32(seed);
  const pool: string[] = [];
  for (const col of ['A', 'B', 'C', 'D']) {
    for (let row = 1; row <= 4; row++) pool.push(`${col}${row}`);
  }
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const genExpr = (depth: number): string => {
    if (depth <= 0) {
      return rand() < 0.5 ? String(Math.floor(rand() * 21) - 10) : pick(pool);
    }
    const kind = rand();
    if (kind < 0.2) return pick(pool);
    if (kind < 0.3) return String(Math.floor(rand() * 11));
    if (kind < 0.4) return `IF(${genExpr(depth - 1)},${genExpr(depth - 1)},${genExpr(depth - 1)})`;
    if (kind < 0.5) return `(-${genExpr(depth - 1)})`;
    const op = pick(['+', '-', '*', '/']);
    return `(${genExpr(depth - 1)}${op}${genExpr(depth - 1)})`;
  };

  const sheet = new Spreadsheet();
  const model: Model = new Map();
  const modelStack: Model[] = [];

  const checkAll = (ctx: string) => {
    for (const ref of pool) {
      const oracle = oracleCell(model, ref);
      assertValueMatches(sheet.get(ref), oracle.value, model, `${ctx} ${ref}`);
      assert.deepEqual(sheet.dependenciesOf(ref), [...oracle.deps].sort(), `${ctx} ${ref} deps`);
    }
  };

  for (let step = 0; step < 400; step++) {
    const action = rand();
    if (action < 0.55) {
      const ref = pick(pool);
      if (rand() < 0.35) {
        const n = Math.floor(rand() * 21) - 10;
        sheet.set(ref, n);
        model.set(ref, n);
      } else {
        const f = `=${genExpr(3)}`;
        sheet.set(ref, f);
        model.set(ref, f);
      }
    } else if (action < 0.7) {
      sheet.begin();
      modelStack.push(new Map(model));
    } else if (action < 0.85) {
      if (modelStack.length > 0) {
        sheet.rollback();
        const restored = modelStack.pop()!;
        model.clear();
        for (const [k, v] of restored) model.set(k, v);
      }
    } else {
      if (modelStack.length > 0) {
        sheet.commit();
        modelStack.pop();
      }
    }
    checkAll(`step ${step}`);
  }
  });
}
