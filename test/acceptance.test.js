"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizePolicy,
  normalizeStock,
  parseDefectsJsonl,
  decideAll,
  buildLedger,
  verifyLedger,
  selectReworkEnumerate,
  selectReworkNaive,
  isFeasible,
} = require("../src");
const { makeWorkspace, runCli, basePolicy, mulberry32 } = require("./helpers");

function decideFromStrings({ policy, stock, defectsText }) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedStock = normalizeStock(stock);
  const entries = parseDefectsJsonl(defectsText, normalizedPolicy);
  const defects = entries.filter((e) => e.kind === "defect").map((e) => e.defect);
  const decisions = decideAll(defects, normalizedPolicy, normalizedStock);
  return { policy: normalizedPolicy, stock: normalizedStock, entries, defects, decisions };
}

test("A: customer blacklist overrides concession even below threshold", () => {
  const policy = basePolicy({ blacklist: ["CUST-EVIL"], concessionThreshold: 100 });
  const { decisions } = decideFromStrings({
    policy,
    stock: {},
    defectsText: [
      JSON.stringify({ id: "D1", product: "SEAL", customer: "CUST-EVIL", amount: 1 }),
      JSON.stringify({ id: "D2", product: "SEAL", customer: "CUST-OK", amount: 1 }),
    ].join("\n"),
  });
  assert.equal(decisions.get("D1").action, "scrap");
  assert.equal(decisions.get("D1").rule, "blacklist");
  assert.equal(decisions.get("D2").action, "concession");
  assert.equal(decisions.get("D2").rule, "below-threshold");
});

test("A: amount threshold decides when no blacklist, tie is rejected", () => {
  const policy = basePolicy({ concessionThreshold: 100 });
  const { decisions } = decideFromStrings({
    policy,
    stock: {},
    defectsText: [
      JSON.stringify({ id: "D1", product: "SEAL", customer: "C", amount: 99 }),
      JSON.stringify({ id: "D2", product: "SEAL", customer: "C", amount: 100 }),
      JSON.stringify({ id: "D3", product: "SEAL", customer: "C", amount: 101 }),
    ].join("\n"),
  });
  assert.equal(decisions.get("D1").action, "concession");
  assert.equal(decisions.get("D2").action, "scrap");
  assert.equal(decisions.get("D2").rule, "tie-reject");
  assert.equal(decisions.get("D3").action, "scrap");
  assert.equal(decisions.get("D3").rule, "above-threshold");
});

test("B: cancelling rework restores stock but not budget; explicit correction restores budget", () => {
  const policy = basePolicy({ shiftBudget: 100 });
  const stock = { BOX: 2 };
  const defectsText = [
    JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 }),
    JSON.stringify({ type: "cancel", defectId: "D1", reason: "customer recalled" }),
  ].join("\n");
  const ctx = decideFromStrings({ policy, stock, defectsText });
  assert.equal(ctx.decisions.get("D1").action, "rework");

  const ledger = buildLedger(ctx.entries, ctx.decisions, ctx.policy, ctx.stock);
  assert.equal(ledger.final.stock.BOX, 2, "stock restored after cancel");
  assert.equal(ledger.final.budget, 90, "budget NOT auto-restored after cancel");
  assert.ok(ledger.cancelled.has("D1"));
  assert.ok(verifyLedger(ctx.policy, ctx.stock, ledger.entries).ok);

  const withCorrection = decideFromStrings({
    policy,
    stock,
    defectsText:
      defectsText +
      "\n" +
      JSON.stringify({ type: "budgetCorrection", amount: 10, reason: "rework waived" }),
  });
  const ledger2 = buildLedger(withCorrection.entries, withCorrection.decisions, ctx.policy, ctx.stock);
  assert.equal(ledger2.final.budget, 100, "explicit correction restores budget");
  assert.ok(verifyLedger(ctx.policy, ctx.stock, ledger2.entries).ok);
});

test("C: equal-savings ties resolve deterministically regardless of input order", () => {
  const policy = basePolicy({ shiftBudget: 10 });
  const stock = { BOX: 2 };
  const d1 = JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 500 });
  const d2 = JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 500 });

  const forward = decideFromStrings({ policy, stock, defectsText: `${d1}\n${d2}` });
  const reversed = decideFromStrings({ policy, stock, defectsText: `${d2}\n${d1}` });

  for (const ctx of [forward, reversed]) {
    assert.equal(ctx.decisions.get("D1").action, "rework", "lexicographically smaller id wins the tie");
    assert.notEqual(ctx.decisions.get("D2").action, "rework");
  }
});

test("D: enumeration matches naive loop for <=20 defects (seeded randomized cross-check)", () => {
  const rng = mulberry32(20261003);
  const products = ["BOX", "LABEL", "SEAL"];
  let cases = 0;

  function randomCase(n) {
    const candidates = [];
    for (let i = 0; i < n; i++) {
      candidates.push({
        id: `D${String(i).padStart(3, "0")}`,
        product: products[Math.floor(rng() * products.length)],
        reworkCost: 1 + Math.floor(rng() * 40),
        savings: 1 + Math.floor(rng() * 200),
      });
    }
    const stock = {};
    for (const p of products) stock[p] = Math.floor(rng() * (n + 1));
    const limits = {
      budget: Math.floor(rng() * 40 * n),
      stockUseCap: Math.floor(rng() * (n + 2)),
      stock,
    };
    return { candidates, limits };
  }

  for (let i = 0; i < 40; i++) {
    const n = 1 + Math.floor(rng() * 15);
    const { candidates, limits } = randomCase(n);
    const fast = selectReworkEnumerate(candidates, limits);
    const naive = selectReworkNaive(candidates, limits);
    assert.deepEqual(naive.ids, fast.ids, `mismatch at n=${n}`);
    assert.ok(isFeasible(fast.selection, candidates, limits));
    cases++;
  }

  for (let i = 0; i < 3; i++) {
    const { candidates, limits } = randomCase(20);
    const fast = selectReworkEnumerate(candidates, limits);
    const naive = selectReworkNaive(candidates, limits);
    assert.deepEqual(naive.ids, fast.ids, "mismatch at n=20");
    assert.ok(isFeasible(fast.selection, candidates, limits));
    cases++;
  }

  assert.ok(cases >= 43);
});

test("defect level inherits product category, explicit level wins", () => {
  const policy = basePolicy();
  const { decisions } = decideFromStrings({
    policy,
    stock: {},
    defectsText: [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 1 }),
      JSON.stringify({ id: "D2", product: "BOX", customer: "C", amount: 1, level: "critical" }),
    ].join("\n"),
  });
  assert.equal(decisions.get("D1").level, "major", "inherited from category BOX");
  assert.equal(decisions.get("D2").level, "critical", "explicit level kept");
});

test("end-to-end CLI run writes decision.jsonl and ledger.jsonl, audit passes", () => {
  const dir = makeWorkspace({
    "policy.json": JSON.stringify(basePolicy({ shiftBudget: 25, blacklist: ["CUST-EVIL"] })),
    "stock.json": JSON.stringify({ BOX: 2, LABEL: 1 }),
    "defects.jsonl": [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C1", amount: 500 }),
      JSON.stringify({ id: "D2", product: "BOX", customer: "CUST-EVIL", amount: 1 }),
      JSON.stringify({ id: "D3", product: "LABEL", customer: "C2", amount: 1 }),
      JSON.stringify({ type: "cancel", defectId: "D1" }),
      JSON.stringify({ type: "budgetCorrection", amount: 10, reason: "waived" }),
    ].join("\n"),
  });
  const run = runCli([
    "run",
    "--defects", path.join(dir, "defects.jsonl"),
    "--policy", path.join(dir, "policy.json"),
    "--stock", path.join(dir, "stock.json"),
    "--outdir", dir,
  ]);
  assert.equal(run.status, 0, run.stderr);

  const decisions = fs
    .readFileSync(path.join(dir, "decision.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  assert.equal(byId.get("D1").action, "rework");
  assert.equal(byId.get("D1").cancelled, true);
  assert.equal(byId.get("D2").action, "scrap");
  assert.equal(byId.get("D2").rule, "blacklist");
  assert.equal(byId.get("D3").action, "concession");

  const audit = runCli([
    "audit",
    "--policy", path.join(dir, "policy.json"),
    "--stock", path.join(dir, "stock.json"),
    "--ledger", path.join(dir, "ledger.jsonl"),
  ]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /AUDIT OK/);
});
