'use strict';

// 立体库堆垛机调度模拟器。
// 任务状态机: created -> assigned -> started -> done | cancelled
// 取消语义: 未 started 立即取消; started 置 cancelPending, 等待 safe_point 后补偿回源位。
// 巷道阻塞时 finish 在出口排队, unblock 后按 (priority, 到达序, task_id) 汇合放行。
// 所有命令幂等: 带 id 的事件按 id 去重; cancel 结果按 task 缓存, 重复 cancel 返回同一结果。

const EVENT_TYPES = new Set([
  'assign',
  'start',
  'finish',
  'cancel',
  'safe_point',
  'block_aisle',
  'unblock_aisle',
]);

class SimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function aisleOf(slotId) {
  const s = String(slotId);
  const idx = s.indexOf('-');
  return idx === -1 ? s : s.slice(0, idx);
}

class Simulator {
  constructor(input) {
    const taskList = Array.isArray(input) ? input : input.tasks || [];
    const slotList = Array.isArray(input) ? [] : input.slots || [];
    this.tasks = new Map();
    this.slots = new Map();
    this.blockedAisles = new Set();
    this.exitQueues = new Map(); // aisle -> [taskId], 到达序
    this.ledger = [];
    this.errors = [];
    this.seq = 0;
    this.arrivalSeq = 0;
    this.seenEventIds = new Map(); // event.id -> result
    this.cancelResults = new Map(); // taskId -> cancel result (幂等)

    for (const s of slotList) {
      const slot = this.ensureSlot(s.id);
      slot.item = s.item == null ? null : s.item;
    }
    for (const t of taskList) {
      const task = {
        id: t.task_id,
        type: t.type, // inbound | outbound | move
        item: t.item,
        from: t.from == null ? null : t.from,
        to: t.to == null ? null : t.to,
        priority: t.priority == null ? 0 : t.priority,
        state: 'created',
        cancelPending: false,
        finishQueued: false,
        arrival: null,
      };
      this.tasks.set(task.id, task);
      if ((task.type === 'outbound' || task.type === 'move') && task.from) {
        const slot = this.ensureSlot(task.from);
        if (slot.item === null) slot.item = task.item;
      }
      if (task.to) this.ensureSlot(task.to);
    }
  }

  ensureSlot(id) {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { id, item: null, reservedBy: null };
      this.slots.set(id, slot);
    }
    return slot;
  }

  log(kind, details) {
    this.ledger.push({ seq: ++this.seq, kind, ...details });
  }

  fail(event, code, message) {
    this.errors.push({ seq: ++this.seq, code, message, event });
    return { ok: false, code, message };
  }

  taskOf(id) {
    const t = this.tasks.get(id);
    if (!t) throw new SimError('UNKNOWN_TASK', `unknown task ${id}`);
    return t;
  }

  applyEvent(ev) {
    if (!ev || typeof ev !== 'object' || !EVENT_TYPES.has(ev.type)) {
      return this.fail(ev, 'UNKNOWN_EVENT', `unknown event type ${ev && ev.type}`);
    }
    if (ev.id !== undefined && this.seenEventIds.has(ev.id)) {
      return this.seenEventIds.get(ev.id); // 幂等重放
    }
    let result;
    try {
      result = this[ev.type](ev);
    } catch (err) {
      if (err instanceof SimError) {
        result = this.fail(ev, err.code, err.message);
      } else {
        throw err;
      }
    }
    if (ev.id !== undefined) this.seenEventIds.set(ev.id, result);
    return result;
  }

  assign(ev) {
    const t = this.taskOf(ev.task_id);
    if (t.state !== 'created') {
      throw new SimError('INVALID_STATE', `assign requires created, got ${t.state} (${t.id})`);
    }
    if (t.to) {
      const slot = this.ensureSlot(t.to);
      if (slot.item !== null || (slot.reservedBy !== null && slot.reservedBy !== t.id)) {
        throw new SimError('SLOT_OCCUPIED', `target slot ${t.to} occupied or reserved`);
      }
      slot.reservedBy = t.id;
    }
    t.state = 'assigned';
    this.log('assign', { task_id: t.id, to: t.to });
    return { ok: true, status: 'assigned' };
  }

  start(ev) {
    const t = this.taskOf(ev.task_id);
    if (t.state !== 'assigned') {
      throw new SimError('INVALID_STATE', `start requires assigned, got ${t.state} (${t.id})`);
    }
    if (t.from) {
      const slot = this.ensureSlot(t.from);
      if (slot.item !== t.item) {
        throw new SimError('ITEM_MISSING', `item ${t.item} not in source slot ${t.from}`);
      }
      slot.item = null;
      // 回程预留: 保证 started 期间取消补偿一定能把货放回原位
      slot.reservedBy = t.id;
    }
    t.state = 'started';
    this.log('start', { task_id: t.id, from: t.from });
    return { ok: true, status: 'started' };
  }

  finish(ev) {
    const t = this.taskOf(ev.task_id);
    if (t.state !== 'started' || t.finishQueued) {
      throw new SimError('INVALID_STATE', `finish requires started, got ${t.state} (${t.id})`);
    }
    const aisle = aisleOf(t.type === 'outbound' ? t.from : t.to);
    if (this.blockedAisles.has(aisle)) {
      t.finishQueued = true;
      t.arrival = ++this.arrivalSeq;
      let q = this.exitQueues.get(aisle);
      if (!q) this.exitQueues.set(aisle, (q = []));
      q.push(t.id);
      this.log('finish_queued', { task_id: t.id, aisle, arrival: t.arrival });
      return { ok: true, status: 'queued', aisle };
    }
    this.completeFinish(t, 'direct');
    return { ok: true, status: 'done' };
  }

  completeFinish(t, via) {
    if (t.type === 'outbound') {
      const src = this.ensureSlot(t.from);
      if (src.reservedBy === t.id) src.reservedBy = null; // 货物离库
    } else {
      const target = this.ensureSlot(t.to);
      if (target.item !== null || (target.reservedBy !== null && target.reservedBy !== t.id)) {
        throw new SimError('SLOT_OCCUPIED', `target slot ${t.to} occupied or reserved`);
      }
      target.item = t.item;
      target.reservedBy = null;
      if (t.from) {
        const src = this.ensureSlot(t.from);
        if (src.reservedBy === t.id) src.reservedBy = null;
      }
    }
    t.state = 'done';
    t.finishQueued = false;
    this.log('finish', { task_id: t.id, via, to: t.to, from: t.from });
  }

  cancel(ev) {
    const t = this.taskOf(ev.task_id);
    if (this.cancelResults.has(t.id)) {
      return this.cancelResults.get(t.id); // 幂等: 重复 cancel 返回同一结果
    }
    let result;
    if (t.state === 'done') {
      result = this.fail(ev, 'INVALID_STATE', `cannot cancel done task ${t.id}`);
    } else if (t.state === 'created' || t.state === 'assigned') {
      if (t.to) {
        const slot = this.ensureSlot(t.to);
        if (slot.reservedBy === t.id) slot.reservedBy = null;
      }
      t.state = 'cancelled';
      this.log('cancel', { task_id: t.id, mode: 'immediate' });
      result = { ok: true, status: 'cancelled', mode: 'immediate' };
    } else {
      // started: 等待 safe_point, 目标位/源位预留均不释放
      t.cancelPending = true;
      this.log('cancel_pending', { task_id: t.id });
      result = { ok: true, status: 'cancelling', mode: 'awaiting_safe_point' };
    }
    this.cancelResults.set(t.id, result);
    return result;
  }

  safe_point(ev) {
    const t = this.taskOf(ev.task_id);
    if (t.state !== 'started' || !t.cancelPending) {
      this.log('safe_point_ignored', { task_id: t.id });
      return { ok: true, status: 'ignored' };
    }
    if (t.finishQueued) {
      const aisle = aisleOf(t.type === 'outbound' ? t.from : t.to);
      const q = this.exitQueues.get(aisle) || [];
      const i = q.indexOf(t.id);
      if (i !== -1) q.splice(i, 1);
      t.finishQueued = false;
    }
    // 补偿回源位
    if (t.type === 'outbound' || t.type === 'move') {
      const src = this.ensureSlot(t.from);
      if (src.item !== null || (src.reservedBy !== null && src.reservedBy !== t.id)) {
        throw new SimError('SLOT_OCCUPIED', `compensation source ${t.from} occupied`);
      }
      src.item = t.item;
      src.reservedBy = null;
    }
    if (t.to) {
      const target = this.ensureSlot(t.to);
      if (target.reservedBy === t.id) target.reservedBy = null;
    }
    t.state = 'cancelled';
    t.cancelPending = false;
    this.log('compensate', { task_id: t.id, restored: t.from || null, released: t.to || null });
    return { ok: true, status: 'cancelled', mode: 'compensated' };
  }

  block_aisle(ev) {
    const aisle = ev.aisle;
    if (this.blockedAisles.has(aisle)) {
      this.log('block_aisle_noop', { aisle });
      return { ok: true, status: 'blocked', already: true };
    }
    this.blockedAisles.add(aisle);
    this.log('block_aisle', { aisle });
    return { ok: true, status: 'blocked' };
  }

  unblock_aisle(ev) {
    const aisle = ev.aisle;
    if (!this.blockedAisles.has(aisle)) {
      this.log('unblock_aisle_noop', { aisle });
      return { ok: true, status: 'unblocked', already: true };
    }
    this.blockedAisles.delete(aisle);
    this.log('unblock_aisle', { aisle });
    const q = this.exitQueues.get(aisle) || [];
    this.exitQueues.set(aisle, []);
    // 汇合放行: 优先级升序 -> 到达序升序 -> task_id 字典序, 完全可复现
    q.sort((a, b) => {
      const ta = this.tasks.get(a);
      const tb = this.tasks.get(b);
      return (
        ta.priority - tb.priority ||
        ta.arrival - tb.arrival ||
        (ta.id < tb.id ? -1 : ta.id > tb.id ? 1 : 0)
      );
    });
    for (const id of q) {
      const t = this.tasks.get(id);
      if (t.state === 'started' && t.finishQueued && !t.cancelPending) {
        this.completeFinish(t, 'unblock');
      }
    }
    return { ok: true, status: 'unblocked', released: q.length };
  }

  finalSlots() {
    const out = {};
    for (const id of [...this.slots.keys()].sort()) {
      out[id] = this.slots.get(id).item;
    }
    return out;
  }

  // 货位一致性不变量, 供测试在每个事件后调用
  checkConsistency() {
    const problems = [];
    const itemLocations = new Map(); // item -> slotId
    for (const slot of this.slots.values()) {
      if (slot.item !== null) {
        if (itemLocations.has(slot.item)) {
          problems.push(`item ${slot.item} in two slots: ${itemLocations.get(slot.item)} and ${slot.id}`);
        }
        itemLocations.set(slot.item, slot.id);
      }
      if (slot.reservedBy !== null) {
        const t = this.tasks.get(slot.reservedBy);
        if (!t || (t.state !== 'assigned' && t.state !== 'started')) {
          problems.push(`slot ${slot.id} reserved by ${slot.reservedBy} in state ${t && t.state}`);
        }
        if (slot.item !== null) {
          problems.push(`slot ${slot.id} both occupied and reserved`);
        }
      }
    }
    // 任意两个活跃任务不得指向同一货位
    const claimants = new Map(); // slotId -> taskId
    for (const t of this.tasks.values()) {
      if (t.state !== 'assigned' && t.state !== 'started') continue;
      for (const key of [t.to, t.state === 'started' ? t.from : null]) {
        if (!key) continue;
        if (claimants.has(key) && claimants.get(key) !== t.id) {
          problems.push(`slot ${key} claimed by both ${claimants.get(key)} and ${t.id}`);
        }
        claimants.set(key, t.id);
      }
    }
    return problems;
  }
}

module.exports = { Simulator, SimError, aisleOf, EVENT_TYPES };
