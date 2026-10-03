// AS/RS stacker-crane dispatcher simulator.
//
// Task state machine: created -> assigned -> started -> done | cancelled
//   - cancel before `started` succeeds immediately (reservations released).
//   - cancel after `started` parks the task in `cancelling`; only a
//     `safe_point` event triggers compensation (goods returned to source).
//   - cancel of a `done` task is an INVALID_STATE error but never aborts
//     the run; repeated cancel returns the cached first result (idempotent).
//
// Aisle blocking: `finish` events in a blocked aisle are deferred into a
// per-aisle exit queue. On `unblock_aisle` the queue drains ordered by
// priority (higher first), then arrival seq, then task_id.

const TASK_TYPES = new Set(['inbound', 'outbound', 'move']);
const ACTIVE_STATES = new Set(['assigned', 'started', 'cancelling']);

export function compareExitOrder(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.exitSeq !== b.exitSeq) return a.exitSeq - b.exitSeq;
  if (a.task_id === b.task_id) return 0;
  return a.task_id < b.task_id ? -1 : 1;
}

export function createSimulation(rawConfig) {
  const config = Array.isArray(rawConfig) ? { tasks: rawConfig } : rawConfig ?? {};

  const slots = new Map(); // id -> { occupiedBy, reservedBy }
  const tasks = new Map(); // id -> task record
  const blockedAisles = new Set();
  const exitQueues = new Map(); // aisle -> [task_id]
  const ledger = [];
  const errors = [];
  const appliedCache = new Map(); // `${type}:${task_id}` -> first ok result
  const cancelCache = new Map(); // task_id -> first cancel result (any outcome)
  let seq = 0;

  const ensureSlot = (id) => {
    let slot = slots.get(id);
    if (!slot) {
      slot = { occupiedBy: null, reservedBy: null };
      slots.set(id, slot);
    }
    return slot;
  };

  const recordError = (event, code, message, taskId = null, aisle = null) => {
    errors.push({ seq, event, task_id: taskId, aisle, code, message });
  };

  const log = (entry) => ledger.push({ seq, ...entry });

  // ---- load tasks.json -------------------------------------------------
  for (const id of config.slots ?? []) {
    if (typeof id === 'string') ensureSlot(id);
  }

  for (const raw of config.tasks ?? []) {
    const id = raw?.task_id;
    if (typeof id !== 'string' || id === '') {
      recordError('load', 'TASK_INVALID', 'task missing task_id');
      continue;
    }
    if (tasks.has(id)) {
      recordError('load', 'TASK_INVALID', `duplicate task_id ${id}`, id);
      continue;
    }
    if (!TASK_TYPES.has(raw.type)) {
      recordError('load', 'TASK_INVALID', `task ${id} has invalid type ${raw.type}`, id);
      continue;
    }
    const source = raw.source ?? null;
    const target = raw.target ?? null;
    const needsSource = raw.type === 'outbound' || raw.type === 'move';
    const needsTarget = raw.type === 'inbound' || raw.type === 'move';
    if ((needsSource && !source) || (needsTarget && !target)) {
      recordError('load', 'TASK_INVALID', `task ${id} missing source/target for ${raw.type}`, id);
      continue;
    }
    if (source && target && source === target) {
      recordError('load', 'TASK_INVALID', `task ${id} source equals target`, id);
      continue;
    }
    tasks.set(id, {
      task_id: id,
      type: raw.type,
      source,
      target,
      priority: Number.isFinite(raw.priority) ? raw.priority : 0,
      aisle: typeof raw.aisle === 'string' ? raw.aisle : null,
      state: 'created',
      carriedGoods: null,
      exitSeq: null,
    });
    if (source) ensureSlot(source);
    if (target) ensureSlot(target);
  }

  for (const id of config.initial_occupied ?? []) {
    const slot = ensureSlot(id);
    if (slot.occupiedBy === null) slot.occupiedBy = `initial:${id}`;
  }
  for (const task of tasks.values()) {
    if ((task.type === 'outbound' || task.type === 'move') && task.source) {
      const slot = ensureSlot(task.source);
      if (slot.occupiedBy === null) slot.occupiedBy = `initial:${task.source}`;
    }
  }

  // ---- slot helpers ----------------------------------------------------
  function releaseReservations(task) {
    for (const id of [task.source, task.target]) {
      if (!id) continue;
      const slot = slots.get(id);
      if (slot && slot.reservedBy === task.task_id) slot.reservedBy = null;
    }
  }

  function completeTask(task, via) {
    if (task.type === 'inbound') {
      const target = slots.get(task.target);
      target.occupiedBy = task.carriedGoods;
      target.reservedBy = null;
    } else if (task.type === 'outbound') {
      slots.get(task.source).reservedBy = null; // goods leave the warehouse
    } else {
      const target = slots.get(task.target);
      target.occupiedBy = task.carriedGoods;
      target.reservedBy = null;
      slots.get(task.source).reservedBy = null;
    }
    task.carriedGoods = null;
    task.exitSeq = null;
    task.state = 'done';
    log({ event: 'finish', task_id: task.task_id, result: 'ok', state: 'done', via });
  }

  function compensate(task) {
    if (task.type === 'inbound') {
      slots.get(task.target).reservedBy = null; // goods returned to I/O port
    } else if (task.type === 'outbound') {
      const source = slots.get(task.source);
      source.occupiedBy = task.carriedGoods; // goods back to source slot
      source.reservedBy = null;
    } else {
      const source = slots.get(task.source);
      source.occupiedBy = task.carriedGoods;
      source.reservedBy = null;
      slots.get(task.target).reservedBy = null;
    }
    task.carriedGoods = null;
    task.exitSeq = null;
  }

  // ---- event handlers --------------------------------------------------
  function doAssign(task) {
    if (task.state !== 'created') {
      recordError('assign', 'INVALID_STATE', `cannot assign task ${task.task_id} in state ${task.state}`, task.task_id);
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (task.type === 'inbound' || task.type === 'move') {
      const target = slots.get(task.target);
      if (target.occupiedBy !== null) {
        recordError('assign', 'SLOT_CONFLICT', `target ${task.target} occupied by ${target.occupiedBy}`, task.task_id);
        return { ok: false, code: 'SLOT_CONFLICT' };
      }
      if (target.reservedBy !== null) {
        recordError('assign', 'SLOT_CONFLICT', `target ${task.target} reserved by ${target.reservedBy}`, task.task_id);
        return { ok: false, code: 'SLOT_CONFLICT' };
      }
    }
    if (task.type === 'outbound' || task.type === 'move') {
      const source = slots.get(task.source);
      if (source.occupiedBy === null) {
        recordError('assign', 'SLOT_EMPTY', `source ${task.source} is empty`, task.task_id);
        return { ok: false, code: 'SLOT_EMPTY' };
      }
      if (source.reservedBy !== null) {
        recordError('assign', 'SLOT_CONFLICT', `source ${task.source} reserved by ${source.reservedBy}`, task.task_id);
        return { ok: false, code: 'SLOT_CONFLICT' };
      }
    }
    if (task.target) slots.get(task.target).reservedBy = task.task_id;
    if (task.source) slots.get(task.source).reservedBy = task.task_id;
    task.state = 'assigned';
    log({ event: 'assign', task_id: task.task_id, result: 'ok', state: 'assigned' });
    return { ok: true, result: 'assigned' };
  }

  function doStart(task) {
    if (task.state !== 'assigned') {
      recordError('start', 'INVALID_STATE', `cannot start task ${task.task_id} in state ${task.state}`, task.task_id);
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (task.type === 'inbound') {
      task.carriedGoods = `goods:${task.task_id}`;
    } else {
      const source = slots.get(task.source);
      task.carriedGoods = source.occupiedBy; // pick goods from source slot
      source.occupiedBy = null;
    }
    task.state = 'started';
    log({ event: 'start', task_id: task.task_id, result: 'ok', state: 'started' });
    return { ok: true, result: 'started' };
  }

  function doFinish(task) {
    if (task.state !== 'started') {
      recordError('finish', 'INVALID_STATE', `cannot finish task ${task.task_id} in state ${task.state}`, task.task_id);
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (task.aisle && blockedAisles.has(task.aisle)) {
      task.exitSeq = seq;
      let queue = exitQueues.get(task.aisle);
      if (!queue) {
        queue = [];
        exitQueues.set(task.aisle, queue);
      }
      queue.push(task.task_id);
      log({ event: 'finish', task_id: task.task_id, result: 'deferred', aisle: task.aisle });
      return { ok: true, result: 'deferred' };
    }
    completeTask(task, 'finish');
    return { ok: true, result: 'done' };
  }

  function doCancel(event) {
    const task = tasks.get(event.task_id);
    if (!task) {
      recordError('cancel', 'UNKNOWN_TASK', `unknown task ${event.task_id}`, event.task_id ?? null);
      return { ok: false, code: 'UNKNOWN_TASK' };
    }
    const cached = cancelCache.get(task.task_id);
    if (cached) return { ...cached, duplicate: true };
    let result;
    if (task.state === 'created' || task.state === 'assigned') {
      releaseReservations(task);
      task.state = 'cancelled';
      log({ event: 'cancel', task_id: task.task_id, result: 'cancelled', state: 'cancelled' });
      result = { ok: true, result: 'cancelled' };
    } else if (task.state === 'started') {
      task.state = 'cancelling';
      log({ event: 'cancel', task_id: task.task_id, result: 'cancel_pending', state: 'cancelling' });
      result = { ok: true, result: 'cancel_pending' };
    } else {
      recordError('cancel', 'INVALID_STATE', `cannot cancel task ${task.task_id} in state ${task.state}`, task.task_id);
      result = { ok: false, code: 'INVALID_STATE', state: task.state };
    }
    cancelCache.set(task.task_id, result);
    return result;
  }

  function doSafePoint(event) {
    const task = tasks.get(event.task_id);
    if (!task) {
      recordError('safe_point', 'UNKNOWN_TASK', `unknown task ${event.task_id}`, event.task_id ?? null);
      return { ok: false, code: 'UNKNOWN_TASK' };
    }
    if (task.state !== 'cancelling') {
      log({ event: 'safe_point', task_id: task.task_id, result: 'ignored' });
      return { ok: true, result: 'ignored' };
    }
    compensate(task);
    task.state = 'cancelled';
    log({ event: 'safe_point', task_id: task.task_id, result: 'compensated', state: 'cancelled' });
    return { ok: true, result: 'compensated' };
  }

  function doBlock(event) {
    if (typeof event.aisle !== 'string' || event.aisle === '') {
      recordError('block_aisle', 'EVENT_INVALID', 'block_aisle requires an aisle');
      return { ok: false, code: 'EVENT_INVALID' };
    }
    if (blockedAisles.has(event.aisle)) return { ok: true, result: 'already_blocked' };
    blockedAisles.add(event.aisle);
    log({ event: 'block_aisle', aisle: event.aisle, result: 'ok' });
    return { ok: true, result: 'blocked' };
  }

  function doUnblock(event) {
    if (typeof event.aisle !== 'string' || event.aisle === '') {
      recordError('unblock_aisle', 'EVENT_INVALID', 'unblock_aisle requires an aisle');
      return { ok: false, code: 'EVENT_INVALID' };
    }
    if (!blockedAisles.has(event.aisle)) return { ok: true, result: 'not_blocked' };
    blockedAisles.delete(event.aisle);
    const queue = exitQueues.get(event.aisle) ?? [];
    exitQueues.set(event.aisle, []);
    const ready = [];
    const skipped = [];
    for (const id of queue) {
      const task = tasks.get(id);
      if (task && task.state === 'started' && task.exitSeq !== null) ready.push(task);
      else skipped.push(id);
    }
    ready.sort(compareExitOrder);
    const exitOrder = ready.map((task) => task.task_id);
    log({ event: 'unblock_aisle', aisle: event.aisle, result: 'ok', exit_order: exitOrder, skipped });
    for (const task of ready) completeTask(task, 'unblock_aisle');
    return { ok: true, result: 'ok', exit_order: exitOrder };
  }

  function withTask(event, handler) {
    const task = tasks.get(event.task_id);
    if (!task) {
      recordError(event.type, 'UNKNOWN_TASK', `unknown task ${event.task_id}`, event.task_id ?? null);
      return { ok: false, code: 'UNKNOWN_TASK' };
    }
    const key = `${event.type}:${task.task_id}`;
    const cached = appliedCache.get(key);
    if (cached) return { ...cached, duplicate: true };
    const result = handler(task);
    if (result.ok) appliedCache.set(key, result);
    return result;
  }

  function apply(event) {
    seq += 1;
    if (!event || typeof event.type !== 'string') {
      recordError('unknown', 'EVENT_INVALID', 'event must be an object with a string type');
      return { ok: false, code: 'EVENT_INVALID' };
    }
    switch (event.type) {
      case 'assign':
        return withTask(event, doAssign);
      case 'start':
        return withTask(event, doStart);
      case 'finish':
        return withTask(event, doFinish);
      case 'cancel':
        return doCancel(event);
      case 'safe_point':
        return doSafePoint(event);
      case 'block_aisle':
        return doBlock(event);
      case 'unblock_aisle':
        return doUnblock(event);
      case '__parse_error__':
        recordError('parse', 'PARSE_ERROR', `invalid JSON on line ${event.line}: ${event.raw}`);
        return { ok: false, code: 'PARSE_ERROR' };
      default:
        recordError(event.type, 'UNKNOWN_EVENT', `unknown event type ${event.type}`);
        return { ok: false, code: 'UNKNOWN_EVENT' };
    }
  }

  // ---- introspection ---------------------------------------------------
  function validateInvariants() {
    const problems = [];
    const goodsLocation = new Map();
    const claim = (goods, where) => {
      if (goodsLocation.has(goods)) {
        problems.push(`goods ${goods} in both ${goodsLocation.get(goods)} and ${where}`);
      } else {
        goodsLocation.set(goods, where);
      }
    };
    for (const [id, slot] of slots) {
      if (slot.occupiedBy !== null) claim(slot.occupiedBy, `slot ${id}`);
      if (slot.reservedBy !== null) {
        const holder = tasks.get(slot.reservedBy);
        if (!holder || !ACTIVE_STATES.has(holder.state)) {
          problems.push(`slot ${id} reserved by ${slot.reservedBy} in state ${holder?.state ?? 'missing'}`);
        }
      }
    }
    for (const task of tasks.values()) {
      if (task.carriedGoods !== null) claim(task.carriedGoods, `crane ${task.task_id}`);
    }
    return problems;
  }

  function snapshot() {
    const slotView = {};
    for (const id of [...slots.keys()].sort()) {
      const slot = slots.get(id);
      slotView[id] = {
        occupied: slot.occupiedBy !== null,
        goods: slot.occupiedBy,
        reserved_by: slot.reservedBy,
      };
    }
    const taskView = {};
    for (const id of [...tasks.keys()].sort()) taskView[id] = tasks.get(id).state;
    return {
      finalSlots: { slots: slotView, tasks: taskView },
      ledger: [...ledger],
      errors: [...errors],
    };
  }

  return {
    apply,
    validateInvariants,
    snapshot,
    get tasks() {
      return tasks;
    },
  };
}

export function runSimulation(config, events) {
  const sim = createSimulation(config);
  for (const event of events ?? []) sim.apply(event);
  return sim.snapshot();
}
