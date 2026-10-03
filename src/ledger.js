import { ClearingError, CODES } from './errors.js';

// Frozen-limit ledger. Locks add to a participant's frozen balance; releases
// subtract. A release larger than the current balance is a replay/integrity
// error: NEGATIVE_RELEASE.
export class LockLedger {
  constructor() {
    this.balances = new Map();
  }

  lock(participant, amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ClearingError(CODES.INVALID_INPUT, `lock amount must be a positive integer, got ${amount}`);
    }
    this.balances.set(participant, (this.balances.get(participant) ?? 0) + amount);
  }

  release(participant, amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ClearingError(CODES.INVALID_INPUT, `release amount must be a positive integer, got ${amount}`);
    }
    const bal = this.balances.get(participant) ?? 0;
    if (amount > bal) {
      throw new ClearingError(
        CODES.NEGATIVE_RELEASE,
        `release of ${amount} for ${participant} exceeds locked balance ${bal}`,
        { participant, locked: bal, release: amount },
      );
    }
    const next = bal - amount;
    if (next === 0) this.balances.delete(participant);
    else this.balances.set(participant, next);
  }

  balanceOf(participant) {
    return this.balances.get(participant) ?? 0;
  }

  snapshot() {
    const out = {};
    for (const k of [...this.balances.keys()].sort()) out[k] = this.balances.get(k);
    return out;
  }
}

// Replay an event log ({type:'lock'|'release', participant, amount}) from an
// empty ledger. Deterministic; throws NEGATIVE_RELEASE on a corrupt log.
export function replayEvents(events) {
  const ledger = new LockLedger();
  for (const e of events) {
    if (e.type === 'lock') ledger.lock(e.participant, e.amount);
    else if (e.type === 'release') ledger.release(e.participant, e.amount);
    else throw new ClearingError(CODES.INVALID_INPUT, `unknown event type ${e.type}`);
  }
  return ledger.snapshot();
}
