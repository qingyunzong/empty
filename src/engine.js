import { round6 } from './util.js';
import { scheduleTasks } from './scheduler.js';

// Incremental margin-call engine.
// - Per-symbol price books keyed by version; only the highest applied version is live.
// - A tick only recomputes accounts holding that symbol (incremental correction).
// - Undo removes the top version and restores the highest remaining valid version,
//   then replays margin evaluation for affected accounts.
export class MarginEngine {
  constructor({ slots, slotCapacity = 1 } = {}) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error('slots must be a positive integer');
    if (!Number.isInteger(slotCapacity) || slotCapacity < 1) throw new Error('slotCapacity must be a positive integer');
    this.slots = slots;
    this.slotCapacity = slotCapacity;
    this.accounts = new Map();
    this.books = new Map(); // symbol -> Map(version -> price)
    this.equityCache = new Map(); // accountId -> equity
    this.negative = new Set();
    this.errors = [];
    this.rolledBack = [];
    this.stats = { recomputes: 0 };
  }

  addAccount(account) {
    const a = { cash: 0, positions: {}, initialMarks: {}, ...account };
    if (this.accounts.has(a.id)) throw new Error(`duplicate account ${a.id}`);
    this.accounts.set(a.id, a);
    this.#recompute(a.id);
  }

  #currentVersion(symbol) {
    const book = this.books.get(symbol);
    if (!book || book.size === 0) return undefined;
    return Math.max(...book.keys());
  }

  #priceOf(symbol) {
    const book = this.books.get(symbol);
    if (!book || book.size === 0) return undefined;
    return book.get(this.#currentVersion(symbol));
  }

  #equityOf(a) {
    let equity = a.cash;
    for (const [symbol, qty] of Object.entries(a.positions)) {
      const price = this.#priceOf(symbol) ?? a.initialMarks[symbol] ?? 0;
      equity += qty * price;
    }
    return round6(equity);
  }

  #recompute(accountId) {
    const a = this.accounts.get(accountId);
    const equity = this.#equityOf(a);
    this.stats.recomputes += 1;
    this.equityCache.set(accountId, equity);
    if (equity < 0) {
      if (!this.negative.has(accountId)) {
        this.negative.add(accountId);
        this.errors.push({ code: 'NEGATIVE_EQUITY', accountId, equity });
      }
    } else {
      this.negative.delete(accountId);
    }
  }

  #affectedAccounts(symbol) {
    const ids = [];
    for (const [id, a] of this.accounts) {
      if (a.positions[symbol]) ids.push(id);
    }
    return ids.sort();
  }

  applyTick({ symbol, version, price }) {
    const current = this.#currentVersion(symbol);
    if (current !== undefined && version <= current) {
      this.errors.push({ code: 'STALE_TICK', symbol, version, currentVersion: current });
      return { applied: false, affected: [] };
    }
    if (!this.books.has(symbol)) this.books.set(symbol, new Map());
    this.books.get(symbol).set(version, price);
    const affected = this.#affectedAccounts(symbol);
    for (const id of affected) this.#recompute(id);
    return { applied: true, affected };
  }

  undoTick(symbol, version) {
    const book = this.books.get(symbol);
    const current = this.#currentVersion(symbol);
    if (current === undefined || version !== current) {
      this.errors.push({ code: 'UNDO_GAP', symbol, version, currentVersion: current ?? null });
      return { ok: false };
    }
    book.delete(version);
    const restored = book.size > 0 ? Math.max(...book.keys()) : null;
    const affected = this.#affectedAccounts(symbol);
    for (const id of affected) this.#recompute(id);
    const replayed = affected.filter((id) => !this.negative.has(id) && this.#gapOf(id) > 0);
    const record = { symbol, undoneVersion: version, restoredVersion: restored, affectedAccounts: affected, replayed };
    this.rolledBack.push(record);
    return { ok: true, rolledBack: record };
  }

  #gapOf(accountId) {
    const a = this.accounts.get(accountId);
    return round6(a.maintenanceLine - this.equityCache.get(accountId));
  }

  buildTasks() {
    const tasks = [];
    for (const [id, a] of this.accounts) {
      const equity = this.equityCache.get(id);
      if (equity < 0) continue; // reported as NEGATIVE_EQUITY, not margin-called
      const gap = round6(a.maintenanceLine - equity);
      if (gap <= 0) continue;
      tasks.push({
        accountId: id,
        priority: a.priority,
        gap,
        liqDistance: round6(equity - a.liquidationLine),
        deadlineSlot: a.deadlineSlot,
        equity,
      });
    }
    return tasks;
  }

  schedule() {
    return scheduleTasks(this.buildTasks(), this.slots, this.slotCapacity);
  }

  finalize() {
    const { calls, errors: schedErrors } = this.schedule();
    return {
      calls,
      rolledBack: this.rolledBack.map((r) => ({ ...r })),
      errors: [...this.errors, ...schedErrors],
    };
  }
}
