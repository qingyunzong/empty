import { test } from "node:test";
import assert from "node:assert/strict";
import { Spreadsheet, Value, DIV_ZERO, CYCLE } from "../src/sheet";

function numOf(v: Value): number {
  assert.equal(v.kind, "num", `expected number, got ${JSON.stringify(v)}`);
  return (v as { kind: "num"; value: number }).value;
}

function codeOf(v: Value): string {
  assert.equal(v.kind, "error", `expected error, got ${JSON.stringify(v)}`);
  return (v as { kind: "error"; code: string }).code;
}

/** Assert the incremental engine agrees with a full-table re-evaluation. */
function checkAgainstFullEval(sheet: Spreadsheet): void {
  const full = sheet.evaluateAll();
  for (const [cell, expected] of full) {
    assert.deepEqual(sheet.getValue(cell), expected, `mismatch at ${cell}`);
  }
}

test("integer arithmetic: precedence, parens, unary minus", () => {
  const s = new Spreadsheet();
  s.setCell("A1", "=1+2*3");
  s.setCell("A2", "=(1+2)*3");
  s.setCell("A3", "=-(4-10)*2");
  s.setCell("A4", "=10-3-2");
  assert.equal(numOf(s.getValue("A1")), 7);
  assert.equal(numOf(s.getValue("A2")), 9);
  assert.equal(numOf(s.getValue("A3")), 12);
  assert.equal(numOf(s.getValue("A4")), 5);
});

test("integer division truncates toward zero", () => {
  const s = new Spreadsheet();
  s.setCell("A1", "=7/2");
  s.setCell("A2", "=-7/2");
  s.setCell("A3", "=7/-2");
  s.setCell("A4", "=0-7");
  s.setCell("A5", "=A4/2");
  assert.equal(numOf(s.getValue("A1")), 3);
  assert.equal(numOf(s.getValue("A2")), -3);
  assert.equal(numOf(s.getValue("A3")), -3);
  assert.equal(numOf(s.getValue("A5")), -3);
});

test("cell references, empty cells read as 0, chained invalidation", () => {
  const s = new Spreadsheet();
  s.setCell("A1", 1);
  s.setCell("B1", "=A1+1");
  s.setCell("C1", "=B1*10+Z9");
  assert.equal(numOf(s.getValue("C1")), 20);
  s.setCell("A1", 10);
  assert.equal(numOf(s.getValue("B1")), 11);
  assert.equal(numOf(s.getValue("C1")), 110);
  assert.deepEqual(s.getDependencies("C1"), ["B1", "Z9"]);
  assert.deepEqual(s.getDependents("A1"), ["B1"]);
});

test("IF tracks only the executed branch, and re-tracks after edits", () => {
  const s = new Spreadsheet();
  s.setCell("A1", 1);
  s.setCell("C1", 5);
  s.setCell("D1", 10);
  s.setCell("B1", "=IF(A1, C1+1, D1+1)");

  assert.equal(numOf(s.getValue("B1")), 6);
  assert.deepEqual(s.getDependencies("B1"), ["A1", "C1"]);

  // Editing the untaken branch must not affect B1.
  s.setCell("D1", 99);
  assert.equal(numOf(s.getValue("B1")), 6);

  // Editing the taken branch propagates.
  s.setCell("C1", 7);
  assert.equal(numOf(s.getValue("B1")), 8);

  // Flip the condition: dependencies are re-tracked to the other branch.
  s.setCell("A1", 0);
  assert.equal(numOf(s.getValue("B1")), 100);
  assert.deepEqual(s.getDependencies("B1"), ["A1", "D1"]);

  // Now C1 edits no longer propagate, D1 edits do.
  s.setCell("C1", 1000);
  assert.equal(numOf(s.getValue("B1")), 100);
  s.setCell("D1", 20);
  assert.equal(numOf(s.getValue("B1")), 21);
});

test("IF with comparison condition", () => {
  const s = new Spreadsheet();
  s.setCell("A1", 42);
  s.setCell("B1", "=IF(A1>=40, 1, 2)");
  assert.equal(numOf(s.getValue("B1")), 1);
  s.setCell("A1", 3);
  assert.equal(numOf(s.getValue("B1")), 2);
});

test("circular reference reports the access path", () => {
  const s = new Spreadsheet();
  s.setCell("A1", "=B1+1");
  s.setCell("B1", "=C1+1");
  s.setCell("C1", "=A1+1");
  const v = s.getValue("A1");
  assert.equal(codeOf(v), CYCLE);
  assert.deepEqual((v as { path?: string[] }).path, ["A1", "B1", "C1", "A1"]);

  // Self reference.
  const s2 = new Spreadsheet();
  s2.setCell("X1", "=X1*2");
  const v2 = s2.getValue("X1");
  assert.equal(codeOf(v2), CYCLE);
  assert.deepEqual((v2 as { path?: string[] }).path, ["X1", "X1"]);

  // Breaking the cycle makes values compute again.
  s.setCell("C1", 5);
  assert.equal(numOf(s.getValue("A1")), 7);
  assert.equal(numOf(s.getValue("B1")), 6);
});

test("division by zero yields an error, never a stale value", () => {
  const s = new Spreadsheet();
  s.setCell("A1", 10);
  s.setCell("B1", 2);
  s.setCell("C1", "=A1/B1");
  s.setCell("D1", "=C1*2");
  assert.equal(numOf(s.getValue("C1")), 5);
  assert.equal(numOf(s.getValue("D1")), 10);

  // Divide by zero: old value 5 must not survive.
  s.setCell("B1", 0);
  assert.equal(codeOf(s.getValue("C1")), DIV_ZERO);
  assert.equal(codeOf(s.getValue("D1")), DIV_ZERO); // error propagates

  // Recover: fresh values flow again.
  s.setCell("B1", 3);
  assert.equal(numOf(s.getValue("C1")), 3);
  assert.equal(numOf(s.getValue("D1")), 6);

  // Direct literal division by zero.
  s.setCell("E1", "=1/0");
  assert.equal(codeOf(s.getValue("E1")), DIV_ZERO);
});

test("transaction rollback restores formulas, values and dependencies", () => {
  const s = new Spreadsheet();
  s.setCell("A1", 1);
  s.setCell("B1", "=A1*2");
  assert.equal(numOf(s.getValue("B1")), 2);
  const depsBefore = s.getDependencies("B1");

  s.beginTransaction();
  s.setCell("A1", 100);
  s.setCell("B1", "=A1+1");
  s.setCell("C1", "=B1*10");
  assert.equal(numOf(s.getValue("C1")), 1010);
  s.rollback();

  assert.equal(s.formulaOf("A1"), 1);
  assert.equal(s.formulaOf("B1"), "=(A1 * 2)");
  assert.equal(s.formulaOf("C1"), undefined);
  assert.equal(numOf(s.getValue("B1")), 2);
  assert.deepEqual(s.getDependencies("B1"), depsBefore);

  // Commit keeps changes.
  s.beginTransaction();
  s.setCell("A1", 5);
  s.commit();
  assert.equal(numOf(s.getValue("B1")), 10);

  // Nested transactions.
  s.beginTransaction();
  s.setCell("A1", 7);
  s.beginTransaction();
  s.setCell("A1", 9);
  s.rollback();
  assert.equal(numOf(s.getValue("B1")), 14);
  s.rollback();
  assert.equal(numOf(s.getValue("B1")), 10);

  assert.throws(() => s.rollback(), /without beginTransaction/);
});

test("incremental results match full-table evaluation across edits", () => {
  const s = new Spreadsheet();
  // Deterministic pseudo-random sheet with refs, IFs and occasional div-by-zero.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const cols = ["A", "B", "C", "D"];
  const refOf = (i: number): string => `${cols[i % 4]}${1 + Math.floor(i / 4)}`;

  for (let i = 0; i < 40; i++) {
    const r = rand();
    const cell = refOf(i);
    if (i < 8 || r % 5 === 0) {
      s.setCell(cell, r % 17 - 8);
    } else {
      const a = refOf(rand() % i);
      const b = refOf(rand() % i);
      const op = ["+", "-", "*", "/"][r % 4];
      const formula =
        r % 3 === 0
          ? `=IF(${a}<>0, ${a}${op}${b}, ${b}*2)`
          : `=${a}${op}(${b}+1)`;
      s.setCell(cell, formula);
    }
  }
  checkAgainstFullEval(s);

  // A round of mutations, then cross-check again.
  for (let i = 0; i < 20; i++) {
    const cell = refOf(rand() % 40);
    if (rand() % 2 === 0) {
      s.setCell(cell, rand() % 9 - 4);
    } else {
      const a = refOf(rand() % 40);
      const b = refOf(rand() % 40);
      s.setCell(cell, `=IF(${a}>=0, ${a}-${b}, ${b}/2)`);
    }
    checkAgainstFullEval(s);
  }
});

test("parse errors are rejected at set time", () => {
  const s = new Spreadsheet();
  assert.throws(() => s.setCell("A1", "=1+"), /unexpected end/);
  assert.throws(() => s.setCell("A1", "=IF(1,2)"), /expected comma/);
  assert.throws(() => s.setCell("A1", "hello"), /must be an integer/);
});
