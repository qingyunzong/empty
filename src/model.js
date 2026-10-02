import { ExitError, EXIT } from './errors.js';

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function loadPolicy(raw) {
  const policy = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!policy || typeof policy !== 'object') throw new Error('policy must be an object');
  const currencies = policy.currencies;
  if (!Array.isArray(currencies) || currencies.length === 0 || currencies.some((c) => typeof c !== 'string')) {
    throw new Error('policy.currencies must be a non-empty string array (known currency codes)');
  }
  const rework = policy.rework ?? {};
  const budget = rework.shiftBudget;
  if (!budget || !isNonNegInt(budget.amount) || typeof budget.currency !== 'string') {
    throw new Error('policy.rework.shiftBudget requires integer amount >= 0 and currency');
  }
  if (!currencies.includes(budget.currency)) {
    throw new ExitError(EXIT.UNKNOWN_CURRENCY, `unknown budget currency: ${budget.currency}`);
  }
  const cost = rework.costPerUnit ?? { amount: 0, currency: budget.currency };
  if (!isNonNegInt(cost.amount) || typeof cost.currency !== 'string'
      || !currencies.includes(cost.currency) || cost.currency !== budget.currency) {
    throw new ExitError(EXIT.UNKNOWN_CURRENCY,
      `rework cost currency must be a known currency equal to the budget currency, got: ${cost.currency}`);
  }
  const concession = policy.concession ?? {};
  const threshold = concession.amountThreshold ?? 0;
  if (!isNonNegInt(threshold)) throw new Error('policy.concession.amountThreshold must be an integer >= 0');
  const blacklist = Array.isArray(concession.blacklist) ? concession.blacklist : [];
  return {
    categories: policy.categories ?? {},
    defaultSeverity: policy.defaultSeverity ?? 'minor',
    rework: {
      allowedSeverities: Array.isArray(rework.allowedSeverities) ? rework.allowedSeverities : [],
      costPerUnit: cost,
      shiftBudget: budget,
    },
    concession: { amountThreshold: threshold, blacklist: new Set(blacklist) },
  };
}

export function loadStock(raw) {
  const stock = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const items = stock && Array.isArray(stock.items) ? stock.items : null;
  if (!items) throw new Error('stock.items must be an array');
  const bySku = new Map();
  for (const item of items) {
    if (!item || typeof item.sku !== 'string' || typeof item.category !== 'string') {
      throw new Error('each stock item requires string sku and category');
    }
    if (!Number.isInteger(item.onHand)) throw new Error(`stock ${item.sku}: onHand must be an integer`);
    if (item.onHand < 0) {
      throw new ExitError(EXIT.NEGATIVE_STOCK, `negative stock for sku ${item.sku}: ${item.onHand}`);
    }
    if (bySku.has(item.sku)) throw new Error(`duplicate stock sku: ${item.sku}`);
    bySku.set(item.sku, { sku: item.sku, category: item.category, onHand: item.onHand });
  }
  return { bySku };
}

// defects.jsonl is an event stream. Event types:
//   {"type":"defect","id","sku","customer","amount"}   (type may be omitted)
//   {"type":"cancel_rework","defectId","reason"?}
//   {"type":"budget_correction","amount","reason"?}
export function parseEvents(raw) {
  const events = [];
  const defectIds = new Set();
  const lines = String(raw).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`defects line ${i + 1}: invalid JSON`);
    }
    const type = event.type ?? 'defect';
    if (type === 'defect') {
      if (typeof event.id !== 'string' || typeof event.sku !== 'string' || typeof event.customer !== 'string') {
        throw new Error(`defects line ${i + 1}: defect requires string id, sku, customer`);
      }
      if (!isNonNegInt(event.amount)) throw new Error(`defects line ${i + 1}: amount must be an integer >= 0`);
      if (defectIds.has(event.id)) {
        throw new ExitError(EXIT.DUPLICATE_DEFECT, `duplicate defect id: ${event.id}`);
      }
      defectIds.add(event.id);
      events.push({ type: 'defect', id: event.id, sku: event.sku, customer: event.customer, amount: event.amount });
    } else if (type === 'cancel_rework') {
      if (typeof event.defectId !== 'string') throw new Error(`defects line ${i + 1}: cancel_rework requires defectId`);
      events.push({ type, defectId: event.defectId, reason: event.reason ?? null });
    } else if (type === 'budget_correction') {
      if (!Number.isInteger(event.amount)) throw new Error(`defects line ${i + 1}: budget_correction requires integer amount`);
      events.push({ type, amount: event.amount, reason: event.reason ?? null });
    } else {
      throw new Error(`defects line ${i + 1}: unknown event type: ${type}`);
    }
  }
  return events;
}

// Defect severity is inherited from the product category of its sku.
export function resolveSeverity(policy, stock, defect) {
  const item = stock.bySku.get(defect.sku);
  const category = item ? item.category : null;
  const fromCategory = category && policy.categories[category] ? policy.categories[category].severity : null;
  return {
    category,
    severity: fromCategory ?? policy.defaultSeverity,
  };
}
