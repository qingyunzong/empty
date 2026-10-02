import { round6 } from './util.js';
import { scheduleTasks } from './scheduler.js';

// Independent full recompute: replays the whole event log from scratch and
// recomputes every account after every event (no incremental caching).
// Used to cross-check the incremental engine and by the CLI for the proof hash.
export function fullRecompute({ accounts, events, slots, slotCapacity = 1 }) {
  const accts = accounts.map((a) => ({ cash: 0, positions: {}, initialMarks: {}, ...a }));
  const books = new Map();
  const errors = [];
  const rolledBack = [];
  const negative = new Set();

  const currentVersion = (symbol) => {
    const book = books.get(symbol);
    if (!book || book.size === 0) return undefined;
    return Math.max(...book.keys());
  };
  const priceOf = (symbol) => {
    const book = books.get(symbol);
    if (!book || book.size === 0) return undefined;
    return book.get(currentVersion(symbol));
  };
  const equityOf = (a) => {
    let equity = a.cash;
    for (const [symbol, qty] of Object.entries(a.positions)) {
      const price = priceOf(symbol) ?? a.initialMarks[symbol] ?? 0;
      equity += qty * price;
    }
    return round6(equity);
  };
  const recheckAll = () => {
    for (const a of [...accts].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
      const equity = equityOf(a);
      if (equity < 0) {
        if (!negative.has(a.id)) {
          negative.add(a.id);
          errors.push({ code: 'NEGATIVE_EQUITY', accountId: a.id, equity });
        }
      } else {
        negative.delete(a.id);
      }
    }
  };

  for (const a of accts) {
    const equity = equityOf(a);
    if (equity < 0) {
      negative.add(a.id);
      errors.push({ code: 'NEGATIVE_EQUITY', accountId: a.id, equity });
    }
  }

  for (const ev of events) {
    if (ev.type === 'undo') {
      const book = books.get(ev.symbol);
      const current = currentVersion(ev.symbol);
      if (current === undefined || ev.version !== current) {
        errors.push({ code: 'UNDO_GAP', symbol: ev.symbol, version: ev.version, currentVersion: current ?? null });
        continue;
      }
      book.delete(ev.version);
      const restored = book.size > 0 ? Math.max(...book.keys()) : null;
      const affected = accts.filter((a) => a.positions[ev.symbol]).map((a) => a.id).sort();
      recheckAll();
      const replayed = affected.filter((id) => {
        if (negative.has(id)) return false;
        const a = accts.find((x) => x.id === id);
        return round6(a.maintenanceLine - equityOf(a)) > 0;
      });
      rolledBack.push({ symbol: ev.symbol, undoneVersion: ev.version, restoredVersion: restored, affectedAccounts: affected, replayed });
    } else {
      const current = currentVersion(ev.symbol);
      if (current !== undefined && ev.version <= current) {
        errors.push({ code: 'STALE_TICK', symbol: ev.symbol, version: ev.version, currentVersion: current });
        continue;
      }
      if (!books.has(ev.symbol)) books.set(ev.symbol, new Map());
      books.get(ev.symbol).set(ev.version, ev.price);
      recheckAll();
    }
  }

  const tasks = [];
  for (const a of accts) {
    const equity = equityOf(a);
    if (equity < 0) continue;
    const gap = round6(a.maintenanceLine - equity);
    if (gap <= 0) continue;
    tasks.push({
      accountId: a.id,
      priority: a.priority,
      gap,
      liqDistance: round6(equity - a.liquidationLine),
      deadlineSlot: a.deadlineSlot,
      equity,
    });
  }
  const { calls, errors: schedErrors } = scheduleTasks(tasks, slots, slotCapacity);
  return { calls, rolledBack, errors: [...errors, ...schedErrors] };
}
