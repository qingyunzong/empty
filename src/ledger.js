import { ReconError, ERR } from './errors.js';

export const MAX_EVENTS = 200;

const DIRECTIONS = new Set(['debit', 'credit']);

export function normalizeEvent(raw, index, side = 'ledger') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index}: expected an object`);
  }
  const { id, account, amount, direction, currency, relId } = raw;
  if (id === undefined || id === null || id === '') {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index}: missing id`);
  }
  if (typeof account !== 'string' || account.length === 0) {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index} (${id}): account must be a non-empty string`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index} (${id}): amount must be a positive finite number`);
  }
  if (!DIRECTIONS.has(direction)) {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index} (${id}): direction must be "debit" or "credit"`);
  }
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index} (${id}): currency must be a non-empty string`);
  }
  if (relId === undefined || relId === null || relId === '') {
    throw new ReconError(ERR.INPUT_INVALID, `${side} event #${index} (${id}): missing relId`);
  }
  return { id: String(id), account, amount, direction, currency, relId: String(relId) };
}

export function validateLedger(events, side = 'ledger') {
  if (events.length > MAX_EVENTS) {
    throw new ReconError(ERR.INPUT_TOO_LARGE, `${side}: ${events.length} events exceeds the ${MAX_EVENTS}-event limit`);
  }
  const seen = new Set();
  for (const e of events) {
    if (seen.has(e.id)) {
      throw new ReconError(ERR.DUP_ID, `${side}: duplicate event id "${e.id}"`);
    }
    seen.add(e.id);
  }
  const currencyByRel = new Map();
  for (const e of events) {
    const cur = currencyByRel.get(e.relId);
    if (cur === undefined) {
      currencyByRel.set(e.relId, e.currency);
    } else if (cur !== e.currency) {
      throw new ReconError(
        ERR.CURRENCY_MIX,
        `${side}: relId "${e.relId}" mixes currencies "${cur}" and "${e.currency}"`,
      );
    }
  }
}

export function prepareLedger(rawEvents, side = 'ledger') {
  if (!Array.isArray(rawEvents)) {
    throw new ReconError(ERR.INPUT_INVALID, `${side}: expected an array of events`);
  }
  const events = rawEvents.map((raw, i) => normalizeEvent(raw, i, side));
  validateLedger(events, side);
  return events;
}

export function parseJsonl(text, side = 'ledger') {
  const events = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new ReconError(ERR.INPUT_INVALID, `${side} line ${i + 1}: invalid JSON`);
    }
    events.push(raw);
  }
  return events;
}
