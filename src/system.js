// 工装寿命预约系统：工单事务（预约/移动/取消/更正/撤销），状态为纯 JSON 可序列化对象。
import { computeSchedule } from './scheduler.js';

const READONLY_COMMANDS = new Set(['schedule', 'state']);

function countMaintenances(sched) {
  return sched.events.filter((e) => e.type === 'maintenance').length;
}

function compareMoldIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class ToolingSystem {
  constructor(state) {
    this.state = state ?? ToolingSystem.emptyState();
  }

  static emptyState() {
    return { molds: {}, orders: {}, txLog: [], nextTxId: 1 };
  }

  static isReadOnly(cmd) {
    return READONLY_COMMANDS.has(cmd?.cmd);
  }

  command(cmd) {
    if (!cmd || typeof cmd.cmd !== 'string') {
      throw new Error('command must be an object with a "cmd" field');
    }
    switch (cmd.cmd) {
      case 'addMold': return this.addMold(cmd);
      case 'reserve': return this.reserve(cmd);
      case 'move': return this.move(cmd);
      case 'cancel': return this.cancel(cmd);
      case 'correct': return this.correct(cmd);
      case 'undo': return this.undo(cmd);
      case 'schedule': return { schedule: this.schedule() };
      case 'state': return { state: this.state };
      default: throw new Error(`unknown command: ${cmd.cmd}`);
    }
  }

  // 重算全部模具的派生调度（调度是模具配置 + 工单队列的纯函数）。
  schedule() {
    const out = {};
    for (const moldId of Object.keys(this.state.molds).sort(compareMoldIds)) {
      const mold = this.state.molds[moldId];
      const orders = mold.queue.map((id) => this.state.orders[id]);
      out[moldId] = computeSchedule(mold, orders);
    }
    return out;
  }

  addMold(cmd) {
    const mold = {
      id: cmd.id ?? cmd.moldId,
      cycleMinutes: cmd.cycleMinutes,
      maintenanceMinutes: cmd.maintenanceMinutes,
      usedMinutes: cmd.usedMinutes ?? 0,
      calendar: cmd.calendar ?? [],
      resetIntervals: cmd.resetIntervals ?? [],
      queue: [],
    };
    if (!mold.id) throw new Error('addMold: id is required');
    computeSchedule(mold, []); // 提前校验配置合法性
    const txId = this.#transact('addMold', [{ cmd: 'insertMold', mold }]);
    return { txId, moldId: mold.id };
  }

  // 预约：不指定 moldId 时在全部模具中选择 —— 保养次数最少，并列取最早完成，再并列取模具ID升序。
  reserve(cmd) {
    const { orderId, durationMinutes } = cmd;
    if (!orderId) throw new Error('reserve: orderId is required');
    if (!(durationMinutes > 0)) throw new Error('reserve: durationMinutes must be > 0');
    if (this.state.orders[orderId]) throw new Error(`order ${orderId} already exists`);
    const candidateIds = cmd.moldId
      ? [cmd.moldId]
      : Object.keys(this.state.molds).sort(compareMoldIds);
    if (candidateIds.length === 0) throw new Error('reserve: no molds available');
    let best = null;
    let firstError = null;
    for (const moldId of candidateIds) {
      let ev;
      try {
        ev = this.#evaluateAppend(moldId, { id: orderId, durationMinutes });
      } catch (e) {
        firstError ??= e;
        continue;
      }
      if (!best || this.#compareCandidates(ev, best) < 0) best = ev;
    }
    if (!best) throw firstError ?? new Error('reserve: no feasible mold');
    const txId = this.#transact('reserve', [{
      cmd: 'insertOrder',
      order: { id: orderId, durationMinutes },
      moldId: best.moldId,
      index: this.state.molds[best.moldId].queue.length,
    }]);
    return {
      txId, orderId, moldId: best.moldId,
      start: best.orderEvent.start, end: best.orderEvent.end,
      maintenances: best.maintenances,
    };
  }

  // 移动：把工单移到另一套模具（追加到目标队列末尾）；不指定 moldId 时自动选最优。
  move(cmd) {
    const { orderId } = cmd;
    const order = this.state.orders[orderId];
    if (!order) throw new Error(`move: unknown order ${orderId}`);
    const from = order.moldId;
    if (cmd.moldId === from) throw new Error(`move: order ${orderId} is already on mold ${from}`);
    const candidateIds = cmd.moldId
      ? [cmd.moldId]
      : Object.keys(this.state.molds).filter((id) => id !== from).sort(compareMoldIds);
    if (candidateIds.length === 0) throw new Error('move: no target mold available');
    // 源模具移除该工单后的保养数（对所有候选相同）。
    const sourceMold = this.state.molds[from];
    const sourceOrders = sourceMold.queue
      .filter((id) => id !== orderId)
      .map((id) => this.state.orders[id]);
    const sourceMaint = countMaintenances(computeSchedule(sourceMold, sourceOrders));
    let best = null;
    let firstError = null;
    for (const moldId of candidateIds) {
      let ev;
      try {
        ev = this.#evaluateAppend(moldId, { id: orderId, durationMinutes: order.durationMinutes });
      } catch (e) {
        firstError ??= e;
        continue;
      }
      ev.cost = ev.maintenanceCount + sourceMaint; // 调整量 = 受影响模具的保养总数
      if (!best || this.#compareCandidates(ev, best) < 0) best = ev;
    }
    if (!best) throw firstError ?? new Error('move: no feasible target mold');
    const txId = this.#transact('move', [
      { cmd: 'deleteOrder', orderId },
      {
        cmd: 'insertOrder',
        order: { id: orderId, durationMinutes: order.durationMinutes },
        moldId: best.moldId,
        index: this.state.molds[best.moldId].queue.length,
      },
    ]);
    return {
      txId, orderId, moldId: best.moldId,
      start: best.orderEvent.start, end: best.orderEvent.end,
      maintenances: best.maintenances,
    };
  }

  cancel(cmd) {
    const { orderId } = cmd;
    if (!this.state.orders[orderId]) throw new Error(`cancel: unknown order ${orderId}`);
    const txId = this.#transact('cancel', [{ cmd: 'deleteOrder', orderId }]);
    return { txId, orderId, removed: true };
  }

  // 增量更正加工时长（deltaMinutes 可正可负），重算派生调度。
  correct(cmd) {
    const { orderId, deltaMinutes } = cmd;
    const order = this.state.orders[orderId];
    if (!order) throw new Error(`correct: unknown order ${orderId}`);
    if (!Number.isFinite(deltaMinutes) || deltaMinutes === 0) {
      throw new Error('correct: deltaMinutes must be a non-zero number');
    }
    const txId = this.#transact('correct', [{ cmd: 'correctOrder', orderId, deltaMinutes }]);
    const mold = this.state.molds[order.moldId];
    const sched = computeSchedule(mold, mold.queue.map((id) => this.state.orders[id]));
    const ev = sched.events.find((e) => e.type === 'order' && e.orderId === orderId);
    return {
      txId, orderId, durationMinutes: order.durationMinutes,
      start: ev.start, end: ev.end,
    };
  }

  // 撤销：按工单事务应用其逆操作，恢复寿命与占用；撤销本身也是一个事务（可再撤销 = 重做）。
  undo(cmd) {
    const { txId } = cmd;
    const tx = this.state.txLog.find((t) => t.txId === txId);
    if (!tx) throw new Error(`undo: unknown txId ${txId}`);
    if (tx.undone) throw new Error(`undo: tx ${txId} already undone`);
    const newTxId = this.#transact(`undo:${txId}`, structuredClone(tx.inverse));
    tx.undone = true;
    return { txId: newTxId, undoes: txId };
  }

  // ---- 内部 ----

  #evaluateAppend(moldId, order) {
    const mold = this.state.molds[moldId];
    if (!mold) throw new Error(`mold ${moldId} not found`);
    const orders = [...mold.queue.map((id) => this.state.orders[id]), order];
    const sched = computeSchedule(mold, orders);
    const maintEvents = sched.events.filter((e) => e.type === 'maintenance');
    const orderEvent = sched.events.findLast((e) => e.type === 'order');
    return {
      moldId,
      maintenanceCount: maintEvents.length,
      maintenances: maintEvents.map(({ start, end }) => ({ start, end })),
      orderEvent,
      cost: maintEvents.length,
    };
  }

  // 调整最少 → 最早完成 → 模具ID升序
  #compareCandidates(a, b) {
    return (a.cost - b.cost)
      || (a.orderEvent.end - b.orderEvent.end)
      || compareMoldIds(a.moldId, b.moldId);
  }

  #transact(label, ops) {
    const inverses = [];
    try {
      for (const op of ops) inverses.unshift(this.#applyPrimitive(op));
    } catch (e) {
      for (const inv of inverses) this.#applyPrimitive(inv); // 回滚，不留半笔事务
      throw e;
    }
    const txId = this.state.nextTxId++;
    this.state.txLog.push({
      txId,
      label,
      forward: structuredClone(ops),
      inverse: inverses.map((o) => structuredClone(o)),
      undone: false,
    });
    return txId;
  }

  #applyPrimitive(op) {
    switch (op.cmd) {
      case 'insertMold': {
        if (this.state.molds[op.mold.id]) throw new Error(`mold ${op.mold.id} already exists`);
        const mold = structuredClone(op.mold);
        mold.queue ??= [];
        this.state.molds[mold.id] = mold;
        return { cmd: 'deleteMold', moldId: mold.id };
      }
      case 'deleteMold': {
        const mold = this.state.molds[op.moldId];
        if (!mold) throw new Error(`mold ${op.moldId} not found`);
        if (mold.queue.length > 0) throw new Error(`mold ${op.moldId} still has orders`);
        delete this.state.molds[op.moldId];
        const { queue, ...rest } = mold;
        return { cmd: 'insertMold', mold: rest };
      }
      case 'insertOrder': {
        const mold = this.state.molds[op.moldId];
        if (!mold) throw new Error(`mold ${op.moldId} not found`);
        if (this.state.orders[op.order.id]) throw new Error(`order ${op.order.id} already exists`);
        this.state.orders[op.order.id] = {
          id: op.order.id,
          durationMinutes: op.order.durationMinutes,
          moldId: op.moldId,
        };
        const idx = Math.min(op.index ?? mold.queue.length, mold.queue.length);
        mold.queue.splice(idx, 0, op.order.id);
        return { cmd: 'deleteOrder', orderId: op.order.id };
      }
      case 'deleteOrder': {
        const order = this.state.orders[op.orderId];
        if (!order) throw new Error(`order ${op.orderId} not found`);
        const mold = this.state.molds[order.moldId];
        const index = mold.queue.indexOf(op.orderId);
        mold.queue.splice(index, 1);
        delete this.state.orders[op.orderId];
        return {
          cmd: 'insertOrder',
          order: { id: order.id, durationMinutes: order.durationMinutes },
          moldId: order.moldId,
          index,
        };
      }
      case 'correctOrder': {
        const order = this.state.orders[op.orderId];
        if (!order) throw new Error(`order ${op.orderId} not found`);
        const next = order.durationMinutes + op.deltaMinutes;
        if (!(next > 0)) {
          throw new Error(`order ${op.orderId}: durationMinutes would become ${next}`);
        }
        order.durationMinutes = next;
        return { cmd: 'correctOrder', orderId: op.orderId, deltaMinutes: -op.deltaMinutes };
      }
      default:
        throw new Error(`unknown primitive op: ${op.cmd}`);
    }
  }
}
