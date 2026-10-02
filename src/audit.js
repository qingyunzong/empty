// Ledger audit: replays the ledger from the initial stock/budget and checks a
// named set of constraints. `minimalMissingConstraints` answers the
// counterexample question: given a ledger that PASSES a weakened audit, which
// missing constraints (each individually sufficient) would catch it?

export const ALL_CHECKS = Object.freeze([
  'init_conservation',
  'step_conservation',
  'budget_non_negative',
  'stock_non_negative',
  'cancel_requires_rework',
  'budget_increase_only_via_correction',
]);

function initialState(policy, stock) {
  const stockState = new Map([...stock.bySku.entries()].map(([sku, item]) => [sku, item.onHand]));
  return { stockState, budget: policy.rework.shiftBudget.amount };
}

function sameStock(a, b) {
  const keys = new Set([...Object.keys(a), ...[...b.keys()]]);
  for (const key of keys) {
    if ((b.get(key) ?? 0) !== (a[key] ?? 0)) return false;
  }
  return true;
}

export function audit(policy, stock, ledger, checks = ALL_CHECKS) {
  const enabled = new Set(checks);
  const violations = [];
  const { stockState, budget } = initialState(policy, stock);
  let budgetState = budget;

  if (ledger.length === 0 || ledger[0].event !== 'init') {
    violations.push({ check: 'init_conservation', seq: null, detail: 'ledger must start with an init entry' });
    return { ok: false, violations };
  }
  if (enabled.has('init_conservation')) {
    const init = ledger[0];
    if (!sameStock(init.stockAfter ?? {}, stockState)) {
      violations.push({ check: 'init_conservation', seq: init.seq, detail: 'init stock does not match stock.json' });
    }
    if (init.budgetAfter !== budgetState) {
      violations.push({ check: 'init_conservation', seq: init.seq, detail: 'init budget does not match policy shift budget' });
    }
  }

  const openReworks = new Set();
  for (let i = 1; i < ledger.length; i += 1) {
    const entry = ledger[i];
    if (typeof entry.sku === 'string' && Number.isInteger(entry.stockDelta)) {
      stockState.set(entry.sku, (stockState.get(entry.sku) ?? 0) + entry.stockDelta);
    }
    if (Number.isInteger(entry.budgetDelta)) budgetState += entry.budgetDelta;

    if (enabled.has('step_conservation')) {
      if (!sameStock(entry.stockAfter ?? {}, stockState) || entry.budgetAfter !== budgetState) {
        violations.push({ check: 'step_conservation', seq: entry.seq,
          detail: `recorded balances do not match replay at seq ${entry.seq}` });
      }
    }
    if (enabled.has('budget_non_negative') && budgetState < 0) {
      violations.push({ check: 'budget_non_negative', seq: entry.seq,
        detail: `budget overdrawn: ${budgetState} at seq ${entry.seq}` });
    }
    if (enabled.has('stock_non_negative')) {
      for (const [sku, onHand] of stockState) {
        if (onHand < 0) {
          violations.push({ check: 'stock_non_negative', seq: entry.seq,
            detail: `stock overdrawn for ${sku}: ${onHand} at seq ${entry.seq}` });
        }
      }
    }
    if (entry.event === 'rework_authorized') openReworks.add(entry.defectId);
    if (entry.event === 'rework_canceled') {
      if (enabled.has('cancel_requires_rework') && !openReworks.has(entry.defectId)) {
        violations.push({ check: 'cancel_requires_rework', seq: entry.seq,
          detail: `cancel of ${entry.defectId} has no matching open rework` });
      }
      openReworks.delete(entry.defectId);
    }
    if (enabled.has('budget_increase_only_via_correction')
        && Number.isInteger(entry.budgetDelta) && entry.budgetDelta > 0
        && entry.event !== 'budget_correction') {
      violations.push({ check: 'budget_increase_only_via_correction', seq: entry.seq,
        detail: `budget increased by non-correction event ${entry.event} at seq ${entry.seq}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Counterexample analysis: the ledger passes under `enforced`; find the
// minimal missing constraints that would make it fail. Each returned check is
// individually sufficient, so the answer is a set of minimal (singleton)
// witnesses.
export function minimalMissingConstraints(policy, stock, ledger, enforced) {
  const current = audit(policy, stock, ledger, enforced);
  if (!current.ok) return { passesUnderEnforced: false, minimalMissing: [] };
  const missing = ALL_CHECKS.filter((c) => !enforced.includes(c));
  const witnesses = missing.filter((check) => !audit(policy, stock, ledger, [...enforced, check]).ok);
  return { passesUnderEnforced: true, minimalMissing: witnesses };
}
