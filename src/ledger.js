"use strict";

const { ExitError } = require("./errors");

function applyDelta(balances, stockDelta, budgetDelta) {
  for (const [product, delta] of Object.entries(stockDelta)) {
    balances.stock[product] = (balances.stock[product] || 0) + delta;
  }
  balances.budget += budgetDelta;
}

function snapshot(balances) {
  return { stock: { ...balances.stock }, budget: balances.budget };
}

// Replays the defect/event stream in file order and emits one ledger entry
// per input line. Rework consumes stock and budget; cancel restores stock
// only (budget is NOT auto-restored); budget corrections are explicit events.
function buildLedger(entries, decisions, policy, stock) {
  const balances = { stock: { ...stock }, budget: policy.shiftBudget };
  const ledgerEntries = [];
  const cancelled = new Set();
  let seq = 0;

  for (const entry of entries) {
    if (entry.kind === "defect") {
      const decision = decisions.get(entry.defect.id);
      const stockDelta = {};
      let budgetDelta = 0;
      if (decision.action === "rework") {
        stockDelta[decision.product] = -1;
        budgetDelta = -decision.reworkCost;
      }
      applyDelta(balances, stockDelta, budgetDelta);
      ledgerEntries.push({
        seq: ++seq,
        type: "decision",
        id: decision.id,
        action: decision.action,
        stockDelta,
        budgetDelta,
        balances: snapshot(balances),
      });
      continue;
    }
    if (entry.kind === "cancel") {
      const decision = decisions.get(entry.defectId);
      if (!decision) {
        throw new ExitError(`cancel references unknown defect ${entry.defectId}`, 1);
      }
      if (decision.action !== "rework") {
        throw new ExitError(`cancel references non-rework defect ${entry.defectId}`, 1);
      }
      if (cancelled.has(entry.defectId)) {
        throw new ExitError(`duplicate cancel for defect ${entry.defectId}`, 1);
      }
      cancelled.add(entry.defectId);
      const stockDelta = { [decision.product]: 1 };
      applyDelta(balances, stockDelta, 0);
      ledgerEntries.push({
        seq: ++seq,
        type: "cancel",
        id: entry.defectId,
        reason: entry.reason,
        stockDelta,
        budgetDelta: 0,
        balances: snapshot(balances),
      });
      continue;
    }
    // budgetCorrection: explicit budget event, never touches stock
    applyDelta(balances, {}, entry.amount);
    ledgerEntries.push({
      seq: ++seq,
      type: "budgetCorrection",
      reason: entry.reason,
      stockDelta: {},
      budgetDelta: entry.amount,
      balances: snapshot(balances),
    });
  }

  for (const [product, qty] of Object.entries(balances.stock)) {
    if (qty < 0) throw new ExitError(`ledger drives stock of ${product} negative`, 1);
  }
  if (balances.budget < 0) {
    throw new ExitError("ledger drives budget negative", 1);
  }
  ledgerEntries.push({
    seq: ++seq,
    type: "final",
    stockDelta: {},
    budgetDelta: 0,
    balances: snapshot(balances),
  });
  return { entries: ledgerEntries, cancelled, final: snapshot(balances) };
}

// Conservation audit: replays the ledger from the initial state and checks
// that every entry's claimed balances match the replayed state, that no
// account ever goes negative, and that budget only moves via rework
// decisions or explicit budgetCorrection events (cancels must not move it).
function verifyLedger(policy, stock, ledgerEntries) {
  const violations = [];
  const balances = { stock: { ...stock }, budget: policy.shiftBudget };
  let expectedSeq = 1;
  let finalSeen = false;

  for (const entry of ledgerEntries) {
    if (entry.seq !== expectedSeq) {
      violations.push(`seq gap: expected ${expectedSeq}, got ${entry.seq}`);
    }
    expectedSeq = entry.seq + 1;

    const stockDelta = entry.stockDelta || {};
    const budgetDelta = entry.budgetDelta || 0;

    if (entry.type === "cancel" && budgetDelta !== 0) {
      violations.push(`seq ${entry.seq}: cancel of ${entry.id} must not change budget`);
    }
    if (entry.type === "decision" && entry.action !== "rework") {
      if (budgetDelta !== 0 || Object.keys(stockDelta).length !== 0) {
        violations.push(`seq ${entry.seq}: ${entry.action} decision must not move stock or budget`);
      }
    }
    if (entry.type === "budgetCorrection" && Object.keys(stockDelta).length !== 0) {
      violations.push(`seq ${entry.seq}: budgetCorrection must not move stock`);
    }

    applyDelta(balances, stockDelta, budgetDelta);

    for (const [product, qty] of Object.entries(balances.stock)) {
      if (qty < 0) violations.push(`seq ${entry.seq}: stock of ${product} went negative (${qty})`);
    }
    if (balances.budget < 0) {
      violations.push(`seq ${entry.seq}: budget went negative (${balances.budget})`);
    }

    if (entry.balances) {
      if (entry.balances.budget !== balances.budget) {
        violations.push(
          `seq ${entry.seq}: budget mismatch, ledger claims ${entry.balances.budget}, replayed ${balances.budget}`
        );
      }
      const claimedStock = entry.balances.stock || {};
      const products = new Set([...Object.keys(balances.stock), ...Object.keys(claimedStock)]);
      for (const product of products) {
        const claimed = claimedStock[product] || 0;
        const replayed = balances.stock[product] || 0;
        if (claimed !== replayed) {
          violations.push(
            `seq ${entry.seq}: stock mismatch for ${product}, ledger claims ${claimed}, replayed ${replayed}`
          );
        }
      }
    }
    if (entry.type === "final") {
      finalSeen = true;
      if (entry.seq !== ledgerEntries[ledgerEntries.length - 1].seq) {
        violations.push(`seq ${entry.seq}: final entry must be the last entry`);
      }
    }
  }

  if (!finalSeen) {
    violations.push("ledger is missing its final conservation entry");
  }
  return { ok: violations.length === 0, violations, final: snapshot(balances) };
}

module.exports = { buildLedger, verifyLedger };
