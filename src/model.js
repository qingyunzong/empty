'use strict';

const MAX_EVENTS_PER_BOOK = 200;

class ReconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
  }
}

function normalizeEvent(raw, bookName, index) {
  const where = `${bookName}[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReconError('BAD_EVENT', `${where}: event must be an object`);
  }
  const { id, account, amount, direction, currency, rel } = raw;
  if (id === undefined || id === null || id === '') {
    throw new ReconError('BAD_EVENT', `${where}: missing id`);
  }
  if (typeof account !== 'string' || account === '') {
    throw new ReconError('BAD_EVENT', `${where}: account must be a non-empty string`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ReconError('BAD_EVENT', `${where}: amount must be a finite number`);
  }
  if (direction !== 'debit' && direction !== 'credit') {
    throw new ReconError('BAD_EVENT', `${where}: direction must be "debit" or "credit"`);
  }
  if (typeof currency !== 'string' || currency === '') {
    throw new ReconError('BAD_EVENT', `${where}: currency must be a non-empty string`);
  }
  if (typeof rel !== 'string' || rel === '') {
    throw new ReconError('BAD_EVENT', `${where}: rel (关联号) must be a non-empty string`);
  }
  return { id: String(id), account, amount, direction, currency, rel };
}

// Validate and normalize a whole book. Throws DUP_ID, CURRENCY_MIX, SIZE_LIMIT.
function normalizeBook(events, bookName) {
  if (!Array.isArray(events)) {
    throw new ReconError('BAD_BOOK', `${bookName}: book must be an array of events`);
  }
  if (events.length > MAX_EVENTS_PER_BOOK) {
    throw new ReconError(
      'SIZE_LIMIT',
      `${bookName}: ${events.length} events exceeds the limit of ${MAX_EVENTS_PER_BOOK}`
    );
  }
  const normalized = events.map((e, i) => normalizeEvent(e, bookName, i));
  const seenIds = new Set();
  for (const e of normalized) {
    if (seenIds.has(e.id)) {
      throw new ReconError('DUP_ID', `${bookName}: duplicate event id "${e.id}"`);
    }
    seenIds.add(e.id);
  }
  const relCurrency = new Map();
  for (const e of normalized) {
    const c = relCurrency.get(e.rel);
    if (c === undefined) {
      relCurrency.set(e.rel, e.currency);
    } else if (c !== e.currency) {
      throw new ReconError(
        'CURRENCY_MIX',
        `${bookName}: relation "${e.rel}" mixes currencies ${c} and ${e.currency}`
      );
    }
  }
  return normalized;
}

function contentKey(e) {
  return JSON.stringify([e.id, e.account, e.amount, e.direction, e.currency, e.rel]);
}

function signedAmount(e) {
  return e.direction === 'debit' ? e.amount : -e.amount;
}

function groupByRel(events) {
  const groups = new Map();
  for (const e of events) {
    if (!groups.has(e.rel)) groups.set(e.rel, []);
    groups.get(e.rel).push(e);
  }
  return groups;
}

function chainsByAccount(events) {
  const chains = new Map();
  for (const e of events) {
    if (!chains.has(e.account)) chains.set(e.account, []);
    chains.get(e.account).push(e.id);
  }
  return chains;
}

function relCurrencyMap(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.rel)) map.set(e.rel, e.currency);
  }
  return map;
}

// Per-relation balance report. A group is balanced iff its signed sum is zero
// and it contains at least one debit and one credit (借贷配对).
function balanceReport(events) {
  const report = [];
  for (const [rel, group] of groupByRel(events)) {
    let sum = 0;
    let debits = 0;
    let credits = 0;
    for (const e of group) {
      sum += signedAmount(e);
      if (e.direction === 'debit') debits += 1;
      else credits += 1;
    }
    report.push({
      rel,
      currency: group[0].currency,
      sum,
      debits,
      credits,
      balanced: sum === 0 && debits > 0 && credits > 0,
    });
  }
  return report;
}

function isBalancedEvents(events) {
  return balanceReport(events).every((g) => g.balanced);
}

module.exports = {
  MAX_EVENTS_PER_BOOK,
  ReconError,
  normalizeBook,
  contentKey,
  signedAmount,
  groupByRel,
  chainsByAccount,
  relCurrencyMap,
  balanceReport,
  isBalancedEvents,
};
