import fs from 'node:fs';
import { RevError, E } from './errors.js';

export const TXN_STATUSES = ['SETTLED', 'PENDING', 'CANCEL_REQUESTED', 'REVERSED', 'FAILED'];

export const TRANSITIONS = {
  reverse: { SETTLED: 'REVERSED', PENDING: 'CANCEL_REQUESTED' },
  cancel: { PENDING: 'CANCEL_REQUESTED' },
};

export class Ledger {
  constructor(data) {
    this.data = data;
    if (!Array.isArray(this.data.txns)) this.data.txns = [];
    if (!Array.isArray(this.data.applied)) this.data.applied = [];
  }

  static load(path) {
    let raw;
    try {
      raw = fs.readFileSync(path, 'utf8');
    } catch (err) {
      throw new RevError(E.IO, `cannot read ledger '${path}': ${err.message}`);
    }
    try {
      return new Ledger(JSON.parse(raw));
    } catch (err) {
      throw new RevError(E.IO, `cannot parse ledger '${path}': ${err.message}`);
    }
  }

  save(path) {
    try {
      fs.writeFileSync(path, JSON.stringify(this.data, null, 2) + '\n');
    } catch (err) {
      throw new RevError(E.IO, `cannot write ledger '${path}': ${err.message}`);
    }
  }

  txn(id) {
    return this.data.txns.find((t) => String(t.id) === String(id)) ?? null;
  }

  isLocked(txn) {
    if (txn.locked === true) return true;
    const day = txn.day ?? null;
    const current = this.data.currentDay ?? null;
    return day != null && current != null && day < current;
  }

  txnAmount(txn) {
    return (txn.entries || []).reduce((sum, e) => sum + (e.debit || 0), 0);
  }

  balances() {
    const out = {};
    for (const txn of this.data.txns) {
      for (const e of txn.entries || []) {
        out[e.account] = (out[e.account] || 0) + (e.debit || 0) - (e.credit || 0);
      }
    }
    return out;
  }

  applyEffect(effect, { pc = null } = {}) {
    const key = effect.reversalId ?? effect.moveId ?? null;
    if (key && this.data.applied.includes(key)) {
      throw new RevError(E.DUP, `effect '${key}' already applied`, {
        txnId: effect.txnId ?? null,
        pc,
      });
    }
    switch (effect.kind) {
      case 'reverse': return this.#applyReverse(effect, pc);
      case 'cancel': return this.#applyCancel(effect, pc);
      case 'move': return this.#applyMove(effect, pc);
      default:
        throw new RevError(E.STATE, `unknown effect kind '${effect.kind}'`, { pc });
    }
  }

  #applyReverse(effect, pc) {
    const txn = this.txn(effect.txnId);
    if (!txn) throw new RevError(E.STATE, `unknown txn '${effect.txnId}'`, { txnId: effect.txnId, pc });
    const target = TRANSITIONS.reverse[txn.status];
    if (!target) {
      throw new RevError(E.STATE, `cannot reverse txn in status ${txn.status}`, { txnId: txn.id, pc });
    }
    if (txn.status === 'SETTLED') {
      if (effect.mode === 'compensate') {
        const comp = (txn.entries || []).map((e) => ({
          account: e.account,
          debit: e.credit || 0,
          credit: e.debit || 0,
          day: this.data.currentDay ?? null,
          compensating: true,
          reversalId: effect.reversalId,
        }));
        txn.entries = [...(txn.entries || []), ...comp];
      } else {
        txn.voidedEntries = txn.entries || [];
        txn.entries = [];
      }
    }
    // PENDING: only a cancel request is recorded; nothing is posted.
    txn.status = target;
    txn.reversalId = effect.reversalId;
    this.data.applied.push(effect.reversalId);
    return txn;
  }

  #applyCancel(effect, pc) {
    const txn = this.txn(effect.txnId);
    if (!txn) throw new RevError(E.STATE, `unknown txn '${effect.txnId}'`, { txnId: effect.txnId, pc });
    const target = TRANSITIONS.cancel[txn.status];
    if (!target) {
      throw new RevError(E.STATE, `cannot cancel txn in status ${txn.status}`, { txnId: txn.id, pc });
    }
    txn.status = target;
    txn.reversalId = effect.reversalId;
    this.data.applied.push(effect.reversalId);
    return txn;
  }

  #applyMove(effect, pc) {
    const accounts = this.data.accounts || {};
    for (const name of [effect.from, effect.to]) {
      if (accounts[name]?.frozen) {
        throw new RevError(E.LOCK, `account '${name}' is frozen`, { pc });
      }
    }
    this.data.txns.push({
      id: effect.moveId,
      kind: 'move',
      status: 'SETTLED',
      day: this.data.currentDay ?? null,
      entries: [
        { account: effect.to, debit: effect.amount, credit: 0 },
        { account: effect.from, debit: 0, credit: effect.amount },
      ],
    });
    this.data.applied.push(effect.moveId);
    return null;
  }
}
