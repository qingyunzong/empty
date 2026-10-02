"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePolicy,
  normalizeStock,
  parseDefectsJsonl,
  decideAll,
  buildLedger,
  verifyLedger,
  violatedConstraints,
  minimalMissingConstraints,
} = require("../src");
const { basePolicy } = require("./helpers");

function buildScenario(defectsText, policyOverrides = {}, stock = { BOX: 3 }) {
  const policy = normalizePolicy(basePolicy(policyOverrides));
  const normalizedStock = normalizeStock(stock);
  const entries = parseDefectsJsonl(defectsText, policy);
  const defects = entries.filter((e) => e.kind === "defect").map((e) => e.defect);
  const decisions = decideAll(defects, policy, normalizedStock);
  const ledger = buildLedger(entries, decisions, policy, normalizedStock);
  return { policy, stock: normalizedStock, entries, defects, decisions, ledger };
}

test("ledger conservation holds across rework, cancel and correction", () => {
  const { policy, stock, ledger } = buildScenario(
    [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
      JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 300 }),
      JSON.stringify({ type: "cancel", defectId: "D2" }),
      JSON.stringify({ type: "budgetCorrection", amount: 10, reason: "waived" }),
    ].join("\n"),
    { shiftBudget: 100 }
  );
  const audit = verifyLedger(policy, stock, ledger.entries);
  assert.ok(audit.ok, audit.violations.join("; "));
  // conservation: initial 100 - 10 (D1) - 10 (D2) + 0 (cancel) + 10 (correction)
  assert.equal(ledger.final.budget, 90);
  // conservation: initial 3 - 1 (D1) - 1 (D2) + 1 (cancel of D2)
  assert.equal(ledger.final.stock.BOX, 2);
});

test("audit detects a tampered ledger (dropped budgetCorrection breaks conservation)", () => {
  const { policy, stock, ledger } = buildScenario(
    [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
      JSON.stringify({ type: "budgetCorrection", amount: 50, reason: "top-up" }),
    ].join("\n"),
    { shiftBudget: 100 }
  );
  assert.ok(verifyLedger(policy, stock, ledger.entries).ok);

  const tampered = ledger.entries
    .filter((e) => e.type !== "budgetCorrection")
    .map((e, i) => ({ ...e, seq: i + 1 }));
  const audit = verifyLedger(policy, stock, tampered);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.length > 0);
});

test("audit rejects a cancel that secretly restores budget", () => {
  const { policy, stock, ledger } = buildScenario(
    [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
      JSON.stringify({ type: "cancel", defectId: "D1" }),
    ].join("\n"),
    { shiftBudget: 100 }
  );
  const forged = ledger.entries.map((e) =>
    e.type === "cancel" ? { ...e, budgetDelta: 10, balances: { ...e.balances, budget: e.balances.budget + 10 } } : e
  );
  const audit = verifyLedger(policy, stock, forged);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some((v) => v.includes("must not change budget")));
});

test("counterexample: minimal missing constraints for an over-budget plan", () => {
  const policy = normalizePolicy(basePolicy({ shiftBudget: 15, stockUseCap: 10 }));
  const stock = normalizeStock({ BOX: 5 });
  const defectsText = [
    JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
    JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 500 }),
  ].join("\n");
  const entries = parseDefectsJsonl(defectsText, policy);
  const defectsById = new Map(
    entries.filter((e) => e.kind === "defect").map((e) => [e.defect.id, e.defect])
  );

  // proposed plan reworks both: cost 20 > budget 15, stock fine
  const violated = violatedConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(violated, ["budget"]);
  const minimal = minimalMissingConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(minimal, [["budget"]], "dropping the budget check alone would let it pass");
});

test("counterexample: two missing constraints needed when budget and cap both exceeded", () => {
  const policy = normalizePolicy(basePolicy({ shiftBudget: 15, stockUseCap: 1 }));
  const stock = normalizeStock({ BOX: 5 });
  const defectsText = [
    JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
    JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 500 }),
  ].join("\n");
  const entries = parseDefectsJsonl(defectsText, policy);
  const defectsById = new Map(
    entries.filter((e) => e.kind === "defect").map((e) => [e.defect.id, e.defect])
  );

  const violated = violatedConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(violated, ["budget", "stockUseCap"]);
  const minimal = minimalMissingConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(minimal, [["budget", "stockUseCap"]]);
});

test("counterexample: per-product stock violation is reported", () => {
  const policy = normalizePolicy(basePolicy({ shiftBudget: 1000, stockUseCap: 10 }));
  const stock = normalizeStock({ BOX: 1 });
  const defectsText = [
    JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
    JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 500 }),
  ].join("\n");
  const entries = parseDefectsJsonl(defectsText, policy);
  const defectsById = new Map(
    entries.filter((e) => e.kind === "defect").map((e) => [e.defect.id, e.defect])
  );

  const violated = violatedConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(violated, ["perProductStock"]);
  const minimal = minimalMissingConstraints(["D1", "D2"], defectsById, policy, stock);
  assert.deepEqual(minimal, [["perProductStock"]]);
});
