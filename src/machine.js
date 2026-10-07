// Domain reducer for the quality closed-loop state machine.
// Pure: given (state, record) it validates and mutates state. No I/O.

export class DomainError extends Error {
  constructor(message) { super(message); this.name = 'DomainError'; this.code = 1; }
}

export class UndoClosedLoopError extends Error {
  constructor(message) { super(message); this.name = 'UndoClosedLoopError'; this.code = 21; }
}

export const INITIAL_STATE = {
  lastSeq: 0,
  defects: {},    // id -> {id, desc, status: open|merged|closed|scrapped, orderId}
  orders: {},     // id -> {id, defectIds, status: open|closed, sequences: [{index, defectId, inspection, affected}]}
  tombstones: {}, // defectId -> {atSeq}  (scrap tombstone, terminal, blocks reopen/rework)
  audit: []       // undo audit trail: {seq, undoOf, op}
};

function mustDefect(state, id) {
  const def = state.defects[id];
  if (!def) throw new DomainError(`unknown defect ${id}`);
  return def;
}

function mustOrder(state, id) {
  const order = state.orders[id];
  if (!order) throw new DomainError(`unknown rework order ${id}`);
  return order;
}

function mustOpenOrder(order) {
  if (order.status === 'closed') throw new DomainError(`rework order ${order.id} is closed`);
}

function isClosedLoopDefect(def) {
  return def.status === 'closed' || def.status === 'scrapped';
}

// Enrich op args with prior values needed later by undo compensation.
export function enrichArgs(state, op, args) {
  if (op === 'inspect') {
    const order = state.orders[args.orderId];
    const seq = order && order.sequences[args.seq];
    return { ...args, prev: seq ? seq.inspection : null };
  }
  if (op === 'correct') {
    const order = state.orders[args.orderId];
    const prevTail = order
      ? order.sequences.slice(args.seq).map((s) => ({ inspection: s.inspection, affected: s.affected }))
      : [];
    return { ...args, prevTail };
  }
  return args;
}

export function applyOp(state, record) {
  const { op, args } = record;
  switch (op) {
    case 'open': {
      if (state.tombstones[args.id]) {
        throw new DomainError(`defect ${args.id} is scrapped: tombstone blocks reopen`);
      }
      if (state.defects[args.id]) throw new DomainError(`defect ${args.id} already exists`);
      state.defects[args.id] = { id: args.id, desc: args.desc || '', status: 'open', orderId: null };
      break;
    }
    case 'rework': {
      const { orderId, defectIds } = args;
      if (!Array.isArray(defectIds) || defectIds.length === 0) {
        throw new DomainError('rework order needs at least one defect');
      }
      if (state.orders[orderId]) throw new DomainError(`rework order ${orderId} already exists`);
      for (const id of defectIds) {
        if (state.tombstones[id]) {
          throw new DomainError(`defect ${id} is scrapped: tombstone blocks rework`);
        }
        const def = mustDefect(state, id);
        if (def.status !== 'open') throw new DomainError(`defect ${id} is not open (status=${def.status})`);
      }
      state.orders[orderId] = {
        id: orderId,
        defectIds: [...defectIds],
        status: 'open',
        sequences: defectIds.map((defectId, index) => ({ index, defectId, inspection: null, affected: false }))
      };
      for (const id of defectIds) {
        state.defects[id].status = 'merged';
        state.defects[id].orderId = orderId;
      }
      break;
    }
    case 'inspect': {
      const order = mustOrder(state, args.orderId);
      mustOpenOrder(order);
      const seq = order.sequences[args.seq];
      if (!seq) throw new DomainError(`order ${order.id} has no sequence ${args.seq}`);
      if (args.result !== 'pass' && args.result !== 'fail') throw new DomainError(`bad inspection result ${args.result}`);
      seq.inspection = args.result;
      break;
    }
    case 'correct': {
      // Re-inspection correction: incremental impact set = sequences >= args.seq
      // of this order only. Earlier sequences and other orders stay untouched.
      const order = mustOrder(state, args.orderId);
      mustOpenOrder(order);
      const seq = order.sequences[args.seq];
      if (!seq) throw new DomainError(`order ${order.id} has no sequence ${args.seq}`);
      if (seq.inspection === null) throw new DomainError(`sequence ${args.seq} has no inspection to correct`);
      if (args.result !== 'pass' && args.result !== 'fail') throw new DomainError(`bad inspection result ${args.result}`);
      seq.inspection = args.result;
      seq.affected = true;
      for (let i = args.seq + 1; i < order.sequences.length; i++) {
        order.sequences[i].inspection = null; // downstream must be re-inspected
        order.sequences[i].affected = true;
      }
      break;
    }
    case 'close': {
      const order = mustOrder(state, args.orderId);
      mustOpenOrder(order);
      for (const seq of order.sequences) {
        if (seq.inspection !== 'pass') {
          throw new DomainError(`order ${order.id} cannot close: sequence ${seq.index} not passed`);
        }
      }
      order.status = 'closed';
      for (const id of order.defectIds) state.defects[id].status = 'closed';
      break;
    }
    case 'scrap': {
      const def = mustDefect(state, args.id);
      if (def.status !== 'open') throw new DomainError(`only an open defect can be scrapped (status=${def.status})`);
      def.status = 'scrapped';
      state.tombstones[args.id] = { atSeq: record.seq };
      break;
    }
    case 'undo': {
      applyUndo(state, record, args.undoOf, args.target);
      break;
    }
    default:
      throw new DomainError(`unknown op ${op}`);
  }
  state.lastSeq = record.seq;
}

function applyUndo(state, record, undoOf, target) {
  switch (target.op) {
    case 'open': {
      const def = state.defects[target.args.id];
      if (!def) throw new DomainError(`defect ${target.args.id} no longer exists`);
      if (isClosedLoopDefect(def)) {
        throw new UndoClosedLoopError(`cannot undo open of ${def.id}: loop closed (status=${def.status})`);
      }
      if (def.status !== 'open') throw new DomainError(`defect ${def.id} already merged; undo the rework first`);
      delete state.defects[def.id];
      break;
    }
    case 'rework': {
      const order = state.orders[target.args.orderId];
      if (!order) throw new DomainError(`rework order ${target.args.orderId} no longer exists`);
      if (order.status === 'closed') {
        throw new UndoClosedLoopError(`cannot undo rework ${order.id}: loop closed`);
      }
      for (const id of order.defectIds) {
        state.defects[id].status = 'open';
        state.defects[id].orderId = null;
      }
      delete state.orders[order.id];
      break;
    }
    case 'inspect': {
      const order = mustOrder(state, target.args.orderId);
      if (order.status === 'closed') {
        throw new UndoClosedLoopError(`cannot undo inspect on ${order.id}: loop closed`);
      }
      order.sequences[target.args.seq].inspection = target.args.prev ?? null;
      break;
    }
    case 'correct': {
      const order = mustOrder(state, target.args.orderId);
      if (order.status === 'closed') {
        throw new UndoClosedLoopError(`cannot undo correct on ${order.id}: loop closed`);
      }
      const tail = target.args.prevTail || [];
      for (let i = 0; i < tail.length; i++) {
        const seq = order.sequences[target.args.seq + i];
        if (seq) { seq.inspection = tail[i].inspection; seq.affected = tail[i].affected; }
      }
      break;
    }
    case 'close':
      throw new UndoClosedLoopError(`cannot undo close of ${target.args.orderId}: loop closed`);
    case 'scrap':
      throw new UndoClosedLoopError(`cannot undo scrap of ${target.args.id}: tombstone is terminal`);
    case 'undo':
      throw new DomainError('cannot undo an undo');
    default:
      throw new DomainError(`cannot undo op ${target.op}`);
  }
  state.audit.push({ seq: record.seq, undoOf, op: target.op });
}
