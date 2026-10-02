'use strict';

const { reschedule, toISO } = require('./model');

class UsageError extends Error {}

const MUTATING = new Set(['addMold', 'book', 'move', 'cancel', 'correct', 'undo']);

function initialState() {
  return { molds: {}, orders: {}, queues: {}, journal: [], txCounter: 0 };
}

function clone(value) {
  return structuredClone(value);
}

function snapshotOf(state) {
  return { molds: clone(state.molds), orders: clone(state.orders), queues: clone(state.queues) };
}

function isoItem(item) {
  const out = { ...item, start: toISO(item.start), end: toISO(item.end) };
  if (item.segments) out.segments = item.segments.map(([s, e]) => [toISO(s), toISO(e)]);
  return out;
}

// Full derived schedule for every mold.
function fullSchedule(state) {
  const byMold = {};
  const orderStart = {};
  const orderEnd = {};
  for (const moldId of Object.keys(state.molds)) {
    const mold = state.molds[moldId];
    const orders = (state.queues[moldId] || []).map((id) => {
      const order = state.orders[id];
      if (!order) throw new UsageError(`queue of ${moldId} references unknown order ${id}`);
      return order;
    });
    const sched = reschedule(mold, orders);
    byMold[moldId] = sched;
    for (const item of sched.items) {
      if (item.type === 'order') {
        orderStart[item.orderId] = `${moldId}@${item.start}`;
        orderEnd[item.orderId] = item.end;
      }
    }
  }
  return { byMold, orderStart, orderEnd };
}

class Engine {
  constructor(store) {
    this.store = store;
    this.state = store.load() || initialState();
  }

  execute(cmd) {
    if (!cmd || typeof cmd.cmd !== 'string') throw new UsageError('command must have a "cmd" field');
    const handler = this[`cmd_${cmd.cmd}`];
    if (!handler) throw new UsageError(`unknown command: ${cmd.cmd}`);

    const mutating = MUTATING.has(cmd.cmd);
    const draft = mutating ? clone(this.state) : this.state;
    const result = handler.call(this, draft, cmd);

    let txId = null;
    if (mutating) {
      if (cmd.cmd !== 'undo') {
        draft.txCounter += 1;
        txId = `tx${draft.txCounter}`;
        draft.journal.push({ txId, cmd: clone(cmd), before: snapshotOf(this.state) });
      }
      // atomic commit: if the store throws (e.g. simulated crash before
      // rename), this.state keeps the pre-command value -> no partial tx.
      this.store.commit(draft);
      this.state = draft;
    }
    return txId ? { txId, ...result } : result;
  }

  // ---- commands ----

  cmd_addMold(state, cmd) {
    const mold = cmd.mold;
    if (!mold || !mold.id) throw new UsageError('addMold requires mold.id');
    if (state.molds[mold.id]) throw new UsageError(`mold already exists: ${mold.id}`);
    if (!(mold.cycleMinutes > 0)) throw new UsageError('mold.cycleMinutes must be > 0');
    if (!(mold.maintenanceMinutes > 0)) throw new UsageError('mold.maintenanceMinutes must be > 0');
    state.molds[mold.id] = clone(mold);
    state.queues[mold.id] = [];
    return { mold: mold.id };
  }

  cmd_book(state, cmd) {
    const order = cmd.order;
    if (!order || !order.id) throw new UsageError('book requires order.id');
    if (state.orders[order.id]) throw new UsageError(`order already exists: ${order.id}`);
    if (!(order.minutes > 0)) throw new UsageError('order.minutes must be > 0');

    const record = {
      id: order.id,
      minutes: order.minutes,
      moldId: null,
      candidates: order.candidates || null,
      notBefore: order.notBefore || null,
    };

    let moldId = order.moldId || null;
    if (moldId) {
      if (!state.molds[moldId]) throw new UsageError(`unknown mold: ${moldId}`);
    } else {
      const candidates = record.candidates || Object.keys(state.molds).sort();
      if (candidates.length === 0) throw new UsageError('no molds available');
      let best = null;
      for (const candidate of candidates) {
        if (!state.molds[candidate]) throw new UsageError(`unknown mold: ${candidate}`);
        const trial = clone(state);
        trial.orders[order.id] = { ...record, moldId: candidate };
        trial.queues[candidate] = trial.queues[candidate].concat(order.id);
        const sched = fullSchedule(trial);
        const completion = sched.orderEnd[order.id];
        if (!best || completion < best.completion ||
            (completion === best.completion && candidate < best.moldId)) {
          best = { moldId: candidate, completion };
        }
      }
      moldId = best.moldId;
    }

    record.moldId = moldId;
    state.orders[order.id] = record;
    state.queues[moldId] = state.queues[moldId].concat(order.id);

    const sched = fullSchedule(state).byMold[moldId];
    const item = sched.items.find((it) => it.type === 'order' && it.orderId === order.id);
    return {
      order: order.id,
      mold: moldId,
      start: toISO(item.start),
      end: toISO(item.end),
      maintenances: sched.maintenances.map(([s, e]) => [toISO(s), toISO(e)]),
    };
  }

  cmd_move(state, cmd) {
    const order = state.orders[cmd.orderId];
    if (!order) throw new UsageError(`unknown order: ${cmd.orderId}`);
    const fromMold = order.moldId;
    const fromIndex = state.queues[fromMold].indexOf(order.id);
    const before = fullSchedule(this.state).orderStart;

    const fromQueue = state.queues[fromMold].filter((id) => id !== order.id);
    const candidateMolds = cmd.moldId
      ? [cmd.moldId]
      : (order.candidates || Object.keys(state.molds).sort());

    let best = null;
    for (const moldId of candidateMolds) {
      if (!state.molds[moldId]) throw new UsageError(`unknown mold: ${moldId}`);
      const baseQueue = moldId === fromMold ? fromQueue : state.queues[moldId].slice();
      const indices = cmd.index != null
        ? [Math.max(0, Math.min(cmd.index, baseQueue.length))]
        : Array.from({ length: baseQueue.length + 1 }, (_, i) => i);
      for (const index of indices) {
        if (moldId === fromMold && index === fromIndex) continue; // no-op
        const trial = clone(state);
        trial.orders[order.id].moldId = moldId;
        trial.queues[fromMold] = fromQueue.slice();
        trial.queues[moldId] = baseQueue.slice();
        trial.queues[moldId].splice(index, 0, order.id);
        const sched = fullSchedule(trial);

        // adjustment cost: other orders whose (mold, start) changed
        let cost = 0;
        for (const [oid, key] of Object.entries(before)) {
          if (oid === order.id) continue;
          if (sched.orderStart[oid] !== key) cost += 1;
        }
        const completion = sched.orderEnd[order.id];
        const candidate = { moldId, index, cost, completion };
        if (!best ||
            cost < best.cost ||
            (cost === best.cost && completion < best.completion) ||
            (cost === best.cost && completion === best.completion &&
             (moldId < best.moldId || (moldId === best.moldId && index < best.index)))) {
          best = candidate;
        }
        if (cmd.moldId && cmd.index != null) break;
      }
    }
    if (!best) throw new UsageError('no feasible placement for move');

    state.orders[order.id].moldId = best.moldId;
    state.queues[fromMold] = fromQueue;
    const target = best.moldId === fromMold ? fromQueue.slice() : state.queues[best.moldId].slice();
    target.splice(best.index, 0, order.id);
    state.queues[best.moldId] = target;

    const sched = fullSchedule(state).byMold[best.moldId];
    const item = sched.items.find((it) => it.type === 'order' && it.orderId === order.id);
    return {
      order: order.id,
      plan: { mold: best.moldId, index: best.index },
      adjustments: best.cost,
      start: toISO(item.start),
      end: toISO(item.end),
    };
  }

  cmd_cancel(state, cmd) {
    const order = state.orders[cmd.orderId];
    if (!order) throw new UsageError(`unknown order: ${cmd.orderId}`);
    const moldId = order.moldId;
    state.queues[moldId] = state.queues[moldId].filter((id) => id !== order.id);
    delete state.orders[order.id];
    return { cancelled: order.id, mold: moldId };
  }

  cmd_correct(state, cmd) {
    const order = state.orders[cmd.orderId];
    if (!order) throw new UsageError(`unknown order: ${cmd.orderId}`);
    if (typeof cmd.deltaMinutes !== 'number') throw new UsageError('correct requires deltaMinutes');
    const minutes = order.minutes + cmd.deltaMinutes;
    if (!(minutes > 0)) throw new UsageError('corrected duration must be > 0');
    order.minutes = minutes;
    const sched = fullSchedule(state).byMold[order.moldId];
    const item = sched.items.find((it) => it.type === 'order' && it.orderId === order.id);
    return {
      order: order.id,
      minutes,
      start: toISO(item.start),
      end: toISO(item.end),
    };
  }

  cmd_undo(state, cmd) {
    const journal = state.journal;
    const idx = cmd.txId ? journal.findIndex((t) => t.txId === cmd.txId) : journal.length - 1;
    if (idx < 0 || idx >= journal.length) throw new UsageError('nothing to undo');
    const tx = journal[idx];
    state.molds = clone(tx.before.molds);
    state.orders = clone(tx.before.orders);
    state.queues = clone(tx.before.queues);
    state.journal = journal.slice(0, idx);
    return { undone: tx.txId };
  }

  cmd_state(state) {
    const sched = fullSchedule(state);
    const molds = {};
    for (const [moldId, mold] of Object.entries(state.molds)) {
      molds[moldId] = {
        ...mold,
        queue: state.queues[moldId].slice(),
        derivedUsedMinutes: sched.byMold[moldId].used,
        schedule: sched.byMold[moldId].items.map(isoItem),
      };
    }
    return {
      molds,
      orders: clone(state.orders),
      journal: state.journal.map((t) => t.txId),
    };
  }

  cmd_schedule(state, cmd) {
    const sched = fullSchedule(state);
    const moldIds = cmd.moldId ? [cmd.moldId] : Object.keys(state.molds);
    const out = {};
    for (const moldId of moldIds) {
      if (!sched.byMold[moldId]) throw new UsageError(`unknown mold: ${moldId}`);
      out[moldId] = sched.byMold[moldId].items.map(isoItem);
    }
    return out;
  }
}

module.exports = { Engine, UsageError, fullSchedule, initialState };
