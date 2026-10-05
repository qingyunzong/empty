import { buildPivot, formatPivot, reconcile, PivotStore } from "../src/index";

const store = new PivotStore();
store.ingestAll([
  { kind: "insert", id: "o1", row: ["CN", "BJ"], col: ["2026", "Q1"], value: 120 },
  { kind: "insert", id: "o2", row: ["CN", "BJ"], col: ["2026", "Q2"], value: 80 },
  { kind: "insert", id: "o3", row: ["CN", null], col: ["2026", "Q1"], value: 15 },
  { kind: "insert", id: "o4", row: [null, "EXPRESS"], col: [null], value: 9007199254740993n },
  // Corrections, each with its own event id:
  { kind: "adjust", id: "fix-1", target: "o1", delta: -20 },
  { kind: "move", id: "fix-2", target: "o2", row: ["CN", "SH"], col: ["2026", "Q2"] },
]);

const pivot = buildPivot(store);
console.log(formatPivot(pivot));
const report = reconcile(store, pivot);
console.log(`reconciled with full-table GROUP BY: ${report.ok ? "OK" : "MISMATCH"}`);
