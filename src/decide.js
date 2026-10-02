import { resolveSeverity } from './model.js';
import { selectRework } from './optimize.js';

// Concession vs scrap conflict resolution:
//   1. customer blacklist wins  -> scrap
//   2. amount < threshold       -> concession
//   3. amount > threshold       -> scrap
//   4. amount == threshold      -> tie, concession rejected -> scrap
function resolveConcessionOrScrap(policy, defect) {
  if (policy.concession.blacklist.has(defect.customer)) {
    return { action: 'scrap', reason: 'blacklist_priority' };
  }
  if (defect.amount < policy.concession.amountThreshold) {
    return { action: 'concession', reason: 'amount_below_threshold' };
  }
  if (defect.amount > policy.concession.amountThreshold) {
    return { action: 'scrap', reason: 'amount_above_threshold' };
  }
  return { action: 'scrap', reason: 'tie_rejected' };
}

function snapshotStock(stockBySku) {
  const out = {};
  for (const [sku, value] of [...stockBySku.entries()].sort()) out[sku] = value;
  return out;
}

// Runs one shift batch: all defect events are decided together (the optimizer
// allocates the scarce budget/stock across the whole batch); cancel_rework and
// budget_correction events are then applied in file order.
export function runBatch(policy, stock, events) {
  const defects = events.filter((e) => e.type === 'defect').map((e) => ({
    ...e,
    ...resolveSeverity(policy, stock, e),
  }));
  const otherEvents = events.filter((e) => e.type !== 'defect');

  const reworkable = defects.filter((d) => policy.rework.allowedSeverities.includes(d.severity));
  const cost = policy.rework.costPerUnit.amount;
  const candidates = reworkable.map((d) => ({
    id: d.id, sku: d.sku, cost, net: d.amount - cost,
  }));
  const stockCaps = new Map([...stock.bySku.entries()].map(([sku, item]) => [sku, item.onHand]));
  const selected = new Set(selectRework(candidates, {
    budget: policy.rework.shiftBudget.amount,
    stockBySku: stockCaps,
  }));

  const decisions = defects.map((d) => {
    if (selected.has(d.id)) {
      return { id: d.id, sku: d.sku, category: d.category, severity: d.severity,
        action: 'rework', reason: 'authorized', amount: d.amount };
    }
    const notReworked = policy.rework.allowedSeverities.includes(d.severity)
      ? 'not_selected_capacity' : 'severity_not_reworkable';
    const verdict = resolveConcessionOrScrap(policy, d);
    return { id: d.id, sku: d.sku, category: d.category, severity: d.severity,
      action: verdict.action, reason: `${notReworked};${verdict.reason}`, amount: d.amount };
  });

  const stockState = new Map([...stock.bySku.entries()].map(([sku, item]) => [sku, item.onHand]));
  let budgetState = policy.rework.shiftBudget.amount;
  const ledger = [];
  let seq = 0;
  const push = (entry) => {
    seq += 1;
    ledger.push({ seq, ...entry, stockAfter: snapshotStock(stockState), budgetAfter: budgetState });
  };
  ledger.push({ seq: 0, event: 'init', stockAfter: snapshotStock(stockState), budgetAfter: budgetState });

  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  for (const d of decisions) {
    if (d.action === 'rework') {
      stockState.set(d.sku, stockState.get(d.sku) - 1);
      budgetState -= cost;
      push({ event: 'rework_authorized', defectId: d.id, sku: d.sku, stockDelta: -1, budgetDelta: -cost });
    } else if (d.action === 'concession') {
      push({ event: 'concession_accepted', defectId: d.id, sku: d.sku, stockDelta: 0, budgetDelta: 0, recovery: d.amount });
    } else {
      push({ event: 'scrapped', defectId: d.id, sku: d.sku, stockDelta: 0, budgetDelta: 0, loss: d.amount });
    }
  }

  const canceled = new Set();
  for (const e of otherEvents) {
    if (e.type === 'cancel_rework') {
      const decision = decisionById.get(e.defectId);
      if (decision && decision.action === 'rework' && !canceled.has(e.defectId)) {
        canceled.add(e.defectId);
        // Stock is returned; the shift budget is NOT auto-restored — that
        // requires an explicit budget_correction event.
        stockState.set(decision.sku, stockState.get(decision.sku) + 1);
        push({ event: 'rework_canceled', defectId: e.defectId, sku: decision.sku,
          stockDelta: 1, budgetDelta: 0, reason: e.reason });
      } else {
        push({ event: 'cancel_ignored', defectId: e.defectId, stockDelta: 0, budgetDelta: 0, reason: e.reason });
      }
    } else if (e.type === 'budget_correction') {
      budgetState += e.amount;
      push({ event: 'budget_correction', stockDelta: 0, budgetDelta: e.amount, reason: e.reason });
    }
  }

  return { decisions, ledger };
}
