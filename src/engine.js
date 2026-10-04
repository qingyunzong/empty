import { scheduleCalls } from './scheduler.js';
import { stableStringify, sha256hex } from './canonical.js';

export const ERRORS = Object.freeze({
  STALE_TICK: 'STALE_TICK',
  NO_CAPACITY: 'NO_CAPACITY',
  NEGATIVE_EQUITY: 'NEGATIVE_EQUITY',
  UNDO_GAP: 'UNDO_GAP',
});

export class RiskEngine {
  constructor(accounts, config = {}) {
    this.config = { slots: config.slots ?? 8, slotCapacity: config.slotCapacity ?? 1 };
    this.accounts = new Map();
    for (const a of accounts) {
      this.accounts.set(a.id, {
        id: a.id,
        priority: a.priority ?? 0,
        liquidationLine: a.liquidationLine,
        deadlineSlot: a.deadlineSlot ?? this.config.slots,
        cash: a.cash ?? 0,
        position: a.position ?? 0,
        history: new Map(), // version -> price (valid, non-undone snapshots)
        head: null, // highest applied version
        price: null,
        equity: null,
        gap: 0,
      });
    }
    this.errors = [];
    this.rolledBack = [];
  }

  account(id) {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`unknown account: ${id}`);
    return a;
  }

  // Incremental recompute: touches exactly one account.
  recompute(acct) {
    if (acct.head === null) {
      acct.price = null;
      acct.equity = null;
      acct.gap = 0;
      return;
    }
    acct.price = acct.history.get(acct.head);
    acct.equity = acct.cash + acct.position * acct.price;
    acct.gap = Math.max(0, acct.liquidationLine - acct.equity);
  }

  applyTick(tick) {
    const { accountId, price, version } = tick;
    const acct = this.account(accountId);
    if (acct.head !== null && version <= acct.head) {
      this.errors.push({ code: ERRORS.STALE_TICK, accountId, version });
      return { ok: false, code: ERRORS.STALE_TICK };
    }
    const equity = acct.cash + acct.position * price;
    if (equity < 0) {
      this.errors.push({ code: ERRORS.NEGATIVE_EQUITY, accountId, version, equity });
      return { ok: false, code: ERRORS.NEGATIVE_EQUITY };
    }
    acct.history.set(version, price);
    acct.head = version;
    this.recompute(acct);
    return { ok: true };
  }

  applyUndo(ev) {
    const { accountId, version } = ev;
    const acct = this.account(accountId);
    if (!acct.history.has(version)) {
      this.errors.push({ code: ERRORS.UNDO_GAP, accountId, version });
      return { ok: false, code: ERRORS.UNDO_GAP };
    }
    acct.history.delete(version);
    if (acct.head === version) {
      const remaining = [...acct.history.keys()];
      acct.head = remaining.length ? Math.max(...remaining) : null;
      this.recompute(acct);
      this.rolledBack.push({ accountId, fromVersion: version, toVersion: acct.head });
    }
    return { ok: true };
  }

  applyEvent(ev) {
    const op = ev.op ?? (ev.price !== undefined ? 'tick' : 'undo');
    return op === 'undo' ? this.applyUndo(ev) : this.applyTick(ev);
  }

  callTasks() {
    const tasks = [];
    for (const a of this.accounts.values()) {
      if (a.head !== null && a.gap > 0) {
        tasks.push({
          id: a.id,
          priority: a.priority,
          liquidationLine: a.liquidationLine,
          equity: a.equity,
          gap: a.gap,
          price: a.price,
          version: a.head,
          deadlineSlot: a.deadlineSlot,
        });
      }
    }
    return tasks;
  }
}

export function runEngine(accounts, events, config = {}) {
  const engine = new RiskEngine(accounts, config);
  for (const ev of events) engine.applyEvent(ev);
  const { scheduled, errors: schedErrors } = scheduleCalls(engine.callTasks(), engine.config);
  const errors = [...engine.errors, ...schedErrors];
  const seed = sha256hex(stableStringify({ accounts, events, config: engine.config })).slice(0, 16);
  const calls = scheduled;
  const rolledBack = engine.rolledBack;
  const scheduleHash = sha256hex(stableStringify({ seed, calls, rolledBack, errors }));
  return {
    calls,
    rolledBack,
    errors,
    proof: {
      seed,
      scheduleHash,
      engine: 'margin-call-engine/1.0.0',
      slots: engine.config.slots,
      slotCapacity: engine.config.slotCapacity,
    },
  };
}
