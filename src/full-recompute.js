import { scheduleCalls } from './scheduler.js';
import { stableStringify, sha256hex } from './canonical.js';

// Independent full recompute used as an oracle for the incremental engine.
// Final account state is derived directly from the raw event log: the
// effective snapshot is the highest version that was applied and never undone.
export function fullRecompute(accounts, events, config = {}) {
  const cfg = { slots: config.slots ?? 8, slotCapacity: config.slotCapacity ?? 1 };
  const errors = [];
  const rolledBack = [];
  const history = new Map(); // id -> Map(version -> price)
  for (const a of accounts) history.set(a.id, new Map());

  const headOf = (id) => {
    const keys = [...history.get(id).keys()];
    return keys.length ? Math.max(...keys) : null;
  };

  for (const ev of events) {
    const op = ev.op ?? (ev.price !== undefined ? 'tick' : 'undo');
    const hist = history.get(ev.accountId);
    if (hist === undefined) throw new Error(`unknown account: ${ev.accountId}`);
    if (op === 'undo') {
      if (!hist.has(ev.version)) {
        errors.push({ code: 'UNDO_GAP', accountId: ev.accountId, version: ev.version });
        continue;
      }
      const wasHead = headOf(ev.accountId) === ev.version;
      hist.delete(ev.version);
      if (wasHead) rolledBack.push({ accountId: ev.accountId, fromVersion: ev.version, toVersion: headOf(ev.accountId) });
      continue;
    }
    const head = headOf(ev.accountId);
    if (head !== null && ev.version <= head) {
      errors.push({ code: 'STALE_TICK', accountId: ev.accountId, version: ev.version });
      continue;
    }
    const acct = accounts.find((a) => a.id === ev.accountId);
    const equity = (acct.cash ?? 0) + (acct.position ?? 0) * ev.price;
    if (equity < 0) {
      errors.push({ code: 'NEGATIVE_EQUITY', accountId: ev.accountId, version: ev.version, equity });
      continue;
    }
    hist.set(ev.version, ev.price);
  }

  const tasks = [];
  for (const a of accounts) {
    const head = headOf(a.id);
    if (head === null) continue;
    const price = history.get(a.id).get(head);
    const equity = (a.cash ?? 0) + (a.position ?? 0) * price;
    const gap = Math.max(0, a.liquidationLine - equity);
    if (gap > 0) {
      tasks.push({
        id: a.id,
        priority: a.priority ?? 0,
        liquidationLine: a.liquidationLine,
        equity,
        gap,
        price,
        version: head,
        deadlineSlot: a.deadlineSlot ?? cfg.slots,
      });
    }
  }

  const { scheduled, errors: schedErrors } = scheduleCalls(tasks, cfg);
  const allErrors = [...errors, ...schedErrors];
  const seed = sha256hex(stableStringify({ accounts, events, config: cfg })).slice(0, 16);
  const scheduleHash = sha256hex(stableStringify({ seed, calls: scheduled, rolledBack, errors: allErrors }));
  return {
    calls: scheduled,
    rolledBack,
    errors: allErrors,
    proof: {
      seed,
      scheduleHash,
      engine: 'margin-call-engine/1.0.0',
      slots: cfg.slots,
      slotCapacity: cfg.slotCapacity,
    },
  };
}
