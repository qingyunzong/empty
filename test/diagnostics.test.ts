import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticStore, type DiagnosticReport } from "../src/diagnostics.js";

function report(partial: Partial<DiagnosticReport>): DiagnosticReport {
  return {
    sourceId: "src-a",
    stage: "parse",
    code: "E001",
    message: "unexpected token",
    cause: "syntax",
    range: { start: 0, end: 5 },
    ...partial,
  };
}

test("merges duplicate errors reported by the same source", () => {
  const store = new DiagnosticStore();
  store.report(report({}));
  store.report(report({}));
  const diags = store.diagnostics();
  assert.equal(diags.length, 1);
  assert.deepEqual(diags[0]!.evidence, [{ sourceId: "src-a", stage: "parse" }]);
});

test("adjacent ranges with different causes are NOT merged", () => {
  const store = new DiagnosticStore();
  store.report(report({ range: { start: 0, end: 5 }, cause: "syntax" }));
  store.report(report({ range: { start: 5, end: 9 }, cause: "undefined-name" }));
  const diags = store.diagnostics();
  assert.equal(diags.length, 2);
  assert.equal(diags[0]!.cause, "syntax");
  assert.equal(diags[1]!.cause, "undefined-name");
});

test("same range with different causes is NOT merged", () => {
  const store = new DiagnosticStore();
  store.report(report({ cause: "syntax" }));
  store.report(report({ cause: "type-mismatch" }));
  assert.equal(store.diagnostics().length, 2);
});

test("same error referenced from multiple stages keeps every piece of evidence", () => {
  const store = new DiagnosticStore();
  store.report(report({ stage: "parse" }));
  store.report(report({ stage: "lint" }));
  store.report(report({ sourceId: "src-b", stage: "parse" }));
  const diags = store.diagnostics();
  assert.equal(diags.length, 1);
  assert.deepEqual(diags[0]!.evidence, [
    { sourceId: "src-a", stage: "lint" },
    { sourceId: "src-a", stage: "parse" },
    { sourceId: "src-b", stage: "parse" },
  ]);
});

test("withdrawing a source removes only that source's references", () => {
  const store = new DiagnosticStore();
  store.report(report({ sourceId: "src-a", stage: "parse" }));
  store.report(report({ sourceId: "src-b", stage: "parse" }));
  store.report(report({ sourceId: "src-a", stage: "lint", code: "E002", message: "unused", cause: "lint", range: { start: 10, end: 12 } }));
  store.withdrawSource("src-a");
  const diags = store.diagnostics();
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "E001");
  assert.deepEqual(diags[0]!.evidence, [{ sourceId: "src-b", stage: "parse" }]);
});

test("diagnostic disappears when its last reference is withdrawn", () => {
  const store = new DiagnosticStore();
  store.report(report({ sourceId: "src-a" }));
  store.withdrawSource("src-a");
  assert.equal(store.diagnostics().length, 0);
});

test("output ordering is stable regardless of insertion order", () => {
  const reports = [
    report({ code: "E003", message: "m3", cause: "c", range: { start: 8, end: 9 } }),
    report({ code: "E001", message: "m1", cause: "b", range: { start: 0, end: 5 } }),
    report({ code: "E002", message: "m2", cause: "a", range: { start: 0, end: 5 } }),
    report({ code: "E001", message: "m1", cause: "a", range: { start: 0, end: 5 } }),
  ];
  const forward = new DiagnosticStore();
  for (const r of reports) forward.report(r);
  const reverse = new DiagnosticStore();
  for (const r of [...reports].reverse()) reverse.report(r);
  const expected = forward.diagnostics();
  assert.deepEqual(reverse.diagnostics(), expected);
  assert.deepEqual(
    expected.map((d) => [d.range.start, d.code, d.cause]),
    [
      [0, "E001", "a"],
      [0, "E001", "b"],
      [0, "E002", "a"],
      [8, "E003", "c"],
    ],
  );
});

test("returned snapshots do not alias store internals", () => {
  const store = new DiagnosticStore();
  store.report(report({}));
  const snapshot = store.diagnostics();
  (snapshot[0]!.range as { start: number }).start = 99;
  (snapshot[0]!.evidence as unknown[]).length = 0;
  assert.equal(store.diagnostics()[0]!.range.start, 0);
  assert.equal(store.diagnostics()[0]!.evidence.length, 1);
});

test("rejects invalid reports", () => {
  const store = new DiagnosticStore();
  assert.throws(() => store.report(report({ range: { start: 5, end: 2 } })));
  assert.throws(() => store.report(report({ range: { start: -1, end: 2 } })));
  assert.throws(() => store.report(report({ range: { start: 0.5, end: 2 } })));
  assert.throws(() => store.report(report({ sourceId: "" })));
  assert.throws(() => store.report(report({ stage: "" })));
});
