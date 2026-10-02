// Pure closed-loop quality state machine.
// Lifecycle: defect open -> merged into rework order -> re-inspection (close)
//   pass  -> defect closed (loop closed)
//   fail  -> defect back to open (needs a new rework order)
//   scrap -> defect tombstoned, can never be reopened or reworked again
// correct  : re-inspection correction, propagates only to the affected sequence
// undo     : allowed only for nodes whose loop is not closed; leaves an audit

export const EXIT = Object.freeze({
  UNDO_AFTER_CLOSE: 21,
  WAL_CHECKSUM: 22,
  HASH_MISMATCH: 23,
});

export class MachineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}

export const RESULTS = Object.freeze(['pass', 'fail', 'scrap']);

export function initialState() {
  return {
    seq: 0,
    defects: {},     // id -> { id, desc, status, orderId, seq: [nodeId...] }
    orders: {},      // id -> { id, defectIds, status, result, closedAt }
    tombstones: {},  // defectId -> { at }
    nodes: {},       // nodeId -> { id, type, defects, undone, ... }
    audits: [],      // undo audit trail
    corrections: [], // re-inspection correction records
  };
}

function fail(message) {
  throw new MachineError(1, message);
}

function nodeId(seq) {
  return `n${seq}`;
}

function addNode(state, node) {
  state.seq += 1;
  const id = nodeId(state.seq);
  const full = { id, undone: false, ...node };
  state.nodes[id] = full;
  for (const d of full.defects ?? []) state.defects[d]?.seq.push(id);
  return full;
}

export function apply(state, op) {
  switch (op.type) {
    case 'open': return applyOpen(state, op);
    case 'rework': return applyRework(state, op);
    case 'close': return applyClose(state, op);
    case 'correct': return applyCorrect(state, op);
    case 'undo': return applyUndo(state, op);
    default: fail(`unknown op type: ${op.type}`);
  }
}

function applyOpen(state, op) {
  const { defectId, desc = '' } = op;
  if (!defectId) fail('open requires defectId');
  if (state.tombstones[defectId]) {
    fail(`defect ${defectId} is scrapped (tombstone); reopen blocked`);
  }
  if (state.defects[defectId]) fail(`defect ${defectId} already exists`);
  state.defects[defectId] = {
    id: defectId, desc, status: 'open', orderId: null, seq: [],
  };
  addNode(state, { type: 'open', defects: [defectId] });
  return state;
}

function applyRework(state, op) {
  const { orderId, defectIds } = op;
  if (!orderId) fail('rework requires orderId');
  if (!Array.isArray(defectIds) || defectIds.length === 0) {
    fail('rework requires at least one defect');
  }
  if (state.orders[orderId]) fail(`rework order ${orderId} already exists`);
  for (const d of defectIds) {
    const def = state.defects[d];
    if (!def) fail(`defect ${d} does not exist`);
    if (state.tombstones[d]) {
      fail(`defect ${d} is scrapped (tombstone); rework blocked`);
    }
    if (def.status !== 'open') {
      fail(`defect ${d} is ${def.status}, not open; cannot merge into rework`);
    }
  }
  state.orders[orderId] = {
    id: orderId, defectIds: [...defectIds], status: 'open',
    result: null, closedAt: null,
  };
  for (const d of defectIds) {
    state.defects[d].status = 'in_rework';
    state.defects[d].orderId = orderId;
  }
  addNode(state, { type: 'rework', defects: [...defectIds], orderId });
  return state;
}

function applyClose(state, op) {
  const { orderId, result } = op;
  if (!RESULTS.includes(result)) fail(`close result must be one of ${RESULTS.join('|')}`);
  const order = state.orders[orderId];
  if (!order) fail(`rework order ${orderId} does not exist`);
  if (order.status !== 'open') fail(`rework order ${orderId} already closed`);
  order.status = 'closed';
  order.result = result;
  order.closedAt = state.seq + 1;
  for (const d of order.defectIds) {
    const def = state.defects[d];
    if (result === 'pass') def.status = 'closed';
    else if (result === 'fail') { def.status = 'open'; def.orderId = null; }
    else { def.status = 'scrapped'; state.tombstones[d] = { at: state.seq + 1 }; }
  }
  addNode(state, { type: 'close', defects: [...order.defectIds], orderId, result });
  return state;
}

// Re-inspection correction: recompute only the affected sequence (the defects
// of the corrected order and every downstream node touching them, following
// merges). Unrelated sequences are left untouched.
function applyCorrect(state, op) {
  const { orderId, result } = op;
  if (!RESULTS.includes(result)) fail(`correct result must be one of ${RESULTS.join('|')}`);
  const order = state.orders[orderId];
  if (!order) fail(`rework order ${orderId} does not exist`);
  if (order.status !== 'closed') fail(`rework order ${orderId} is not closed; nothing to correct`);
  const from = order.result;
  if (from === result) fail(`order ${orderId} already has result ${result}`);

  const closeSeq = order.closedAt;
  const affectedDefects = new Set(order.defectIds);
  const impactSet = [];
  for (let s = closeSeq + 1; s <= state.seq; s += 1) {
    const node = state.nodes[nodeId(s)];
    if (!node || node.undone) continue;
    if ((node.defects ?? []).some((d) => affectedDefects.has(d))) {
      impactSet.push(node.id);
      for (const d of node.defects ?? []) affectedDefects.add(d);
    }
  }

  order.result = result;
  const override = { [nodeId(closeSeq)]: result };
  for (const d of affectedDefects) {
    const def = state.defects[d];
    if (!def) continue; // defect removed by an undone open
    def.status = replayDefectStatus(state, d, override);
    if (def.status === 'scrapped') state.tombstones[d] = { at: state.seq + 1 };
    else delete state.tombstones[d];
    if (def.status !== 'in_rework') def.orderId = null;
    else {
      const last = lastReworkNode(state, d);
      def.orderId = last ? last.orderId : null;
    }
  }

  state.corrections.push({
    orderId, from, to: result, impactSet, at: state.seq + 1,
  });
  addNode(state, {
    type: 'correct', defects: [...affectedDefects], orderId, result, impactSet,
  });
  return state;
}

// Replay one defect's own node sequence to derive its status, with optional
// per-node result overrides (used for corrections).
function replayDefectStatus(state, defectId, overrides = {}) {
  const def = state.defects[defectId];
  let status = 'open';
  for (const nid of def.seq) {
    const node = state.nodes[nid];
    if (!node || node.undone) continue;
    if (node.type === 'rework') status = 'in_rework';
    else if (node.type === 'close') {
      const result = overrides[node.id] ?? node.result;
      if (result === 'pass') status = 'closed';
      else if (result === 'fail') status = 'open';
      else status = 'scrapped';
    }
  }
  return status;
}

function lastReworkNode(state, defectId) {
  const def = state.defects[defectId];
  for (let i = def.seq.length - 1; i >= 0; i -= 1) {
    const node = state.nodes[def.seq[i]];
    if (node && !node.undone && node.type === 'rework') return node;
  }
  return null;
}

function applyUndo(state, op) {
  const { nodeId: nid, reason = '' } = op;
  const node = state.nodes[nid];
  if (!node) fail(`node ${nid} does not exist`);
  if (node.undone) fail(`node ${nid} already undone`);
  if (node.type === 'close' || node.type === 'correct') {
    throw new MachineError(
      EXIT.UNDO_AFTER_CLOSE,
      `node ${nid} is a closed-loop node; undo after close is forbidden`,
    );
  }
  for (const d of node.defects ?? []) {
    const def = state.defects[d];
    if (def && (def.status === 'closed' || def.status === 'scrapped')) {
      throw new MachineError(
        EXIT.UNDO_AFTER_CLOSE,
        `defect ${d} loop is ${def.status}; undo after close is forbidden`,
      );
    }
  }
  if (node.type === 'open') {
    const [d] = node.defects;
    const def = state.defects[d];
    if (!def || def.status !== 'open') {
      fail(`defect ${d} is no longer open; cannot undo open`);
    }
    delete state.defects[d];
  } else if (node.type === 'rework') {
    const order = state.orders[node.orderId];
    if (!order || order.status !== 'open') {
      fail(`rework order ${node.orderId} is no longer open; cannot undo rework`);
    }
    for (const d of order.defectIds) {
      state.defects[d].status = 'open';
      state.defects[d].orderId = null;
    }
    delete state.orders[node.orderId];
  } else {
    fail(`cannot undo node of type ${node.type}`);
  }
  node.undone = true;
  state.audits.push({ undoOf: nid, op: node.type, reason, at: state.seq + 1 });
  addNode(state, { type: 'undo', defects: [...(node.defects ?? [])], undoOf: nid });
  return state;
}

// Derived index. Rebuilt from state (never incremented), so recovery after an
// index-update crash cannot double count.
export function buildIndex(state) {
  const defectsByStatus = {};
  for (const def of Object.values(state.defects)) {
    defectsByStatus[def.status] = (defectsByStatus[def.status] ?? 0) + 1;
  }
  const ordersByStatus = {};
  for (const order of Object.values(state.orders)) {
    ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
  }
  return {
    seq: state.seq,
    defectsByStatus,
    ordersByStatus,
    tombstones: Object.keys(state.tombstones).length,
    audits: state.audits.length,
    corrections: state.corrections.length,
  };
}
