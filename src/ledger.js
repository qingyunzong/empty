import { createHash } from 'node:crypto';

export const ACTIONS = Object.freeze(['FREEZE', 'CONFIRM', 'CANCEL']);

const ACTION_RANK = Object.freeze({ FREEZE: 0, CONFIRM: 1, CANCEL: 2 });

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function assertEvent(event, index) {
  const where = `events[${index}]`;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new LedgerError('INVALID_EVENT', `${where} must be an object`);
  }
  const { requestId, idempotencyKey, ts, amount, action } = event;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new LedgerError('INVALID_EVENT', `${where}.requestId must be a non-empty string`);
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new LedgerError('INVALID_EVENT', `${where}.idempotencyKey must be a non-empty string`);
  }
  if (!Number.isFinite(ts)) {
    throw new LedgerError('INVALID_EVENT', `${where}.ts must be a finite number`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('INVALID_EVENT', `${where}.amount must be a positive finite number`);
  }
  if (!(action in ACTION_RANK)) {
    throw new LedgerError('INVALID_EVENT', `${where}.action must be one of ${ACTIONS.join('/')}`);
  }
}

function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.requestId !== b.requestId) return a.requestId < b.requestId ? -1 : 1;
  if (ACTION_RANK[a.action] !== ACTION_RANK[b.action]) {
    return ACTION_RANK[a.action] - ACTION_RANK[b.action];
  }
  return a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0;
}

// Dedupe identical retries by idempotency key, then impose the unique serial
// order: logical timestamp, then requestId, then action rank, then key.
export function canonicalOrder(events) {
  if (!Array.isArray(events)) {
    throw new LedgerError('INVALID_HISTORY', 'events must be an array');
  }
  events.forEach(assertEvent);
  const byKey = new Map();
  for (const event of events) {
    const prev = byKey.get(event.idempotencyKey);
    if (prev) {
      const same =
        prev.requestId === event.requestId &&
        prev.action === event.action &&
        prev.ts === event.ts &&
        prev.amount === event.amount;
      if (!same) {
        throw new LedgerError(
          'IDEMPOTENCY_CONFLICT',
          `idempotencyKey "${event.idempotencyKey}" reused with a different payload`
        );
      }
      continue;
    }
    byKey.set(event.idempotencyKey, event);
  }
  return [...byKey.values()].sort(compareEvents);
}

function sortedRequestStates(requests) {
  const out = {};
  for (const key of [...requests.keys()].sort()) {
    out[key] = requests.get(key);
  }
  return out;
}

// Replay an event history against a quota pool and produce a deterministic
// certificate. The result depends only on the set of events, never on their
// physical arrival order.
export function replay(history, quota) {
  if (!Number.isFinite(quota) || quota < 0) {
    throw new LedgerError('INVALID_QUOTA', 'quota must be a non-negative finite number');
  }
  const events = canonicalOrder(history);

  const requests = new Map();
  let reserved = 0;
  let consumed = 0;
  const decisions = [];
  const acceptedOrder = [];

  events.forEach((event, seq) => {
    const state = requests.get(event.requestId) ?? 'NONE';
    let status;
    let accepted = false;

    switch (event.action) {
      case 'FREEZE': {
        if (state === 'NONE' || state === 'REJECTED') {
          if (quota - reserved - consumed >= event.amount) {
            reserved += event.amount;
            requests.set(event.requestId, 'FROZEN');
            status = 'FROZEN';
            accepted = true;
          } else {
            requests.set(event.requestId, 'REJECTED');
            status = 'REJECTED_INSUFFICIENT_QUOTA';
          }
        } else if (state === 'FROZEN') {
          status = 'DUPLICATE';
        } else {
          status = 'INVALID_STATE';
        }
        break;
      }
      case 'CONFIRM': {
        if (state === 'FROZEN') {
          reserved -= event.amount;
          consumed += event.amount;
          requests.set(event.requestId, 'CONFIRMED');
          status = 'CONFIRMED';
          accepted = true;
        } else if (state === 'CONFIRMED') {
          status = 'DUPLICATE';
        } else if (state === 'CANCELLED' || state === 'COMPENSATED') {
          status = 'CONFLICT_ALREADY_CANCELLED';
        } else {
          // NONE or REJECTED: confirm without an accepted freeze is invalid.
          status = 'CONFIRM_WITHOUT_FREEZE';
        }
        break;
      }
      case 'CANCEL': {
        if (state === 'FROZEN') {
          reserved -= event.amount;
          requests.set(event.requestId, 'CANCELLED');
          status = 'CANCELLED';
          accepted = true;
        } else if (state === 'CONFIRMED') {
          // Late cancel after confirm: emit a compensating release.
          consumed -= event.amount;
          requests.set(event.requestId, 'COMPENSATED');
          status = 'COMPENSATED';
          accepted = true;
        } else if (state === 'CANCELLED' || state === 'COMPENSATED') {
          status = 'DUPLICATE';
        } else {
          status = 'CANCEL_WITHOUT_FREEZE';
        }
        break;
      }
    }

    const decision = {
      seq,
      requestId: event.requestId,
      action: event.action,
      ts: event.ts,
      idempotencyKey: event.idempotencyKey,
      amount: event.amount,
      status,
      accepted,
    };
    decisions.push(decision);
    if (accepted) {
      acceptedOrder.push({ seq, requestId: event.requestId, action: event.action, status });
    }
  });

  const finalState = {
    quota,
    reserved,
    consumed,
    available: quota - reserved - consumed,
    requests: sortedRequestStates(requests),
  };

  const stateHash = createHash('sha256')
    .update(JSON.stringify({ quota, decisions, finalState }))
    .digest('hex');

  return { quota, acceptedOrder, decisions, finalState, stateHash };
}
