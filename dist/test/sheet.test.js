"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const sheet_1 = require("../src/sheet");
function numOf(v) {
    strict_1.default.equal(v.kind, "num", `expected number, got ${JSON.stringify(v)}`);
    return v.value;
}
function codeOf(v) {
    strict_1.default.equal(v.kind, "error", `expected error, got ${JSON.stringify(v)}`);
    return v.code;
}
/** Assert the incremental engine agrees with a full-table re-evaluation. */
function checkAgainstFullEval(sheet) {
    const full = sheet.evaluateAll();
    for (const [cell, expected] of full) {
        strict_1.default.deepEqual(sheet.getValue(cell), expected, `mismatch at ${cell}`);
    }
}
(0, node_test_1.test)("integer arithmetic: precedence, parens, unary minus", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", "=1+2*3");
    s.setCell("A2", "=(1+2)*3");
    s.setCell("A3", "=-(4-10)*2");
    s.setCell("A4", "=10-3-2");
    strict_1.default.equal(numOf(s.getValue("A1")), 7);
    strict_1.default.equal(numOf(s.getValue("A2")), 9);
    strict_1.default.equal(numOf(s.getValue("A3")), 12);
    strict_1.default.equal(numOf(s.getValue("A4")), 5);
});
(0, node_test_1.test)("integer division truncates toward zero", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", "=7/2");
    s.setCell("A2", "=-7/2");
    s.setCell("A3", "=7/-2");
    s.setCell("A4", "=0-7");
    s.setCell("A5", "=A4/2");
    strict_1.default.equal(numOf(s.getValue("A1")), 3);
    strict_1.default.equal(numOf(s.getValue("A2")), -3);
    strict_1.default.equal(numOf(s.getValue("A3")), -3);
    strict_1.default.equal(numOf(s.getValue("A5")), -3);
});
(0, node_test_1.test)("cell references, empty cells read as 0, chained invalidation", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", 1);
    s.setCell("B1", "=A1+1");
    s.setCell("C1", "=B1*10+Z9");
    strict_1.default.equal(numOf(s.getValue("C1")), 20);
    s.setCell("A1", 10);
    strict_1.default.equal(numOf(s.getValue("B1")), 11);
    strict_1.default.equal(numOf(s.getValue("C1")), 110);
    strict_1.default.deepEqual(s.getDependencies("C1"), ["B1", "Z9"]);
    strict_1.default.deepEqual(s.getDependents("A1"), ["B1"]);
});
(0, node_test_1.test)("IF tracks only the executed branch, and re-tracks after edits", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", 1);
    s.setCell("C1", 5);
    s.setCell("D1", 10);
    s.setCell("B1", "=IF(A1, C1+1, D1+1)");
    strict_1.default.equal(numOf(s.getValue("B1")), 6);
    strict_1.default.deepEqual(s.getDependencies("B1"), ["A1", "C1"]);
    // Editing the untaken branch must not affect B1.
    s.setCell("D1", 99);
    strict_1.default.equal(numOf(s.getValue("B1")), 6);
    // Editing the taken branch propagates.
    s.setCell("C1", 7);
    strict_1.default.equal(numOf(s.getValue("B1")), 8);
    // Flip the condition: dependencies are re-tracked to the other branch.
    s.setCell("A1", 0);
    strict_1.default.equal(numOf(s.getValue("B1")), 100);
    strict_1.default.deepEqual(s.getDependencies("B1"), ["A1", "D1"]);
    // Now C1 edits no longer propagate, D1 edits do.
    s.setCell("C1", 1000);
    strict_1.default.equal(numOf(s.getValue("B1")), 100);
    s.setCell("D1", 20);
    strict_1.default.equal(numOf(s.getValue("B1")), 21);
});
(0, node_test_1.test)("IF with comparison condition", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", 42);
    s.setCell("B1", "=IF(A1>=40, 1, 2)");
    strict_1.default.equal(numOf(s.getValue("B1")), 1);
    s.setCell("A1", 3);
    strict_1.default.equal(numOf(s.getValue("B1")), 2);
});
(0, node_test_1.test)("circular reference reports the access path", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", "=B1+1");
    s.setCell("B1", "=C1+1");
    s.setCell("C1", "=A1+1");
    const v = s.getValue("A1");
    strict_1.default.equal(codeOf(v), sheet_1.CYCLE);
    strict_1.default.deepEqual(v.path, ["A1", "B1", "C1", "A1"]);
    // Self reference.
    const s2 = new sheet_1.Spreadsheet();
    s2.setCell("X1", "=X1*2");
    const v2 = s2.getValue("X1");
    strict_1.default.equal(codeOf(v2), sheet_1.CYCLE);
    strict_1.default.deepEqual(v2.path, ["X1", "X1"]);
    // Breaking the cycle makes values compute again.
    s.setCell("C1", 5);
    strict_1.default.equal(numOf(s.getValue("A1")), 7);
    strict_1.default.equal(numOf(s.getValue("B1")), 6);
});
(0, node_test_1.test)("division by zero yields an error, never a stale value", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", 10);
    s.setCell("B1", 2);
    s.setCell("C1", "=A1/B1");
    s.setCell("D1", "=C1*2");
    strict_1.default.equal(numOf(s.getValue("C1")), 5);
    strict_1.default.equal(numOf(s.getValue("D1")), 10);
    // Divide by zero: old value 5 must not survive.
    s.setCell("B1", 0);
    strict_1.default.equal(codeOf(s.getValue("C1")), sheet_1.DIV_ZERO);
    strict_1.default.equal(codeOf(s.getValue("D1")), sheet_1.DIV_ZERO); // error propagates
    // Recover: fresh values flow again.
    s.setCell("B1", 3);
    strict_1.default.equal(numOf(s.getValue("C1")), 3);
    strict_1.default.equal(numOf(s.getValue("D1")), 6);
    // Direct literal division by zero.
    s.setCell("E1", "=1/0");
    strict_1.default.equal(codeOf(s.getValue("E1")), sheet_1.DIV_ZERO);
});
(0, node_test_1.test)("transaction rollback restores formulas, values and dependencies", () => {
    const s = new sheet_1.Spreadsheet();
    s.setCell("A1", 1);
    s.setCell("B1", "=A1*2");
    strict_1.default.equal(numOf(s.getValue("B1")), 2);
    const depsBefore = s.getDependencies("B1");
    s.beginTransaction();
    s.setCell("A1", 100);
    s.setCell("B1", "=A1+1");
    s.setCell("C1", "=B1*10");
    strict_1.default.equal(numOf(s.getValue("C1")), 1010);
    s.rollback();
    strict_1.default.equal(s.formulaOf("A1"), 1);
    strict_1.default.equal(s.formulaOf("B1"), "=(A1 * 2)");
    strict_1.default.equal(s.formulaOf("C1"), undefined);
    strict_1.default.equal(numOf(s.getValue("B1")), 2);
    strict_1.default.deepEqual(s.getDependencies("B1"), depsBefore);
    // Commit keeps changes.
    s.beginTransaction();
    s.setCell("A1", 5);
    s.commit();
    strict_1.default.equal(numOf(s.getValue("B1")), 10);
    // Nested transactions.
    s.beginTransaction();
    s.setCell("A1", 7);
    s.beginTransaction();
    s.setCell("A1", 9);
    s.rollback();
    strict_1.default.equal(numOf(s.getValue("B1")), 14);
    s.rollback();
    strict_1.default.equal(numOf(s.getValue("B1")), 10);
    strict_1.default.throws(() => s.rollback(), /without beginTransaction/);
});
(0, node_test_1.test)("incremental results match full-table evaluation across edits", () => {
    const s = new sheet_1.Spreadsheet();
    // Deterministic pseudo-random sheet with refs, IFs and occasional div-by-zero.
    let seed = 12345;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
    };
    const cols = ["A", "B", "C", "D"];
    const refOf = (i) => `${cols[i % 4]}${1 + Math.floor(i / 4)}`;
    for (let i = 0; i < 40; i++) {
        const r = rand();
        const cell = refOf(i);
        if (i < 8 || r % 5 === 0) {
            s.setCell(cell, r % 17 - 8);
        }
        else {
            const a = refOf(rand() % i);
            const b = refOf(rand() % i);
            const op = ["+", "-", "*", "/"][r % 4];
            const formula = r % 3 === 0
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
        }
        else {
            const a = refOf(rand() % 40);
            const b = refOf(rand() % 40);
            s.setCell(cell, `=IF(${a}>=0, ${a}-${b}, ${b}/2)`);
        }
        checkAgainstFullEval(s);
    }
});
(0, node_test_1.test)("parse errors are rejected at set time", () => {
    const s = new sheet_1.Spreadsheet();
    strict_1.default.throws(() => s.setCell("A1", "=1+"), /unexpected end/);
    strict_1.default.throws(() => s.setCell("A1", "=IF(1,2)"), /expected comma/);
    strict_1.default.throws(() => s.setCell("A1", "hello"), /must be an integer/);
});
