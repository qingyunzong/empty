'use strict';

const EXIT_OK = 0;
const EXIT_BUDGET = 5;
const EXIT_MONOTONIC = 11;

// CNC tool-life service core.
// ops: [{ t, type: 'MEASURE'|'CHANGE'|'RESET', tool, wear?, new?, admin?, seq, sent? }]
// options: { limit, max, window }
//   limit  - wear limit; MEASURE reaching it raises an alarm, RESET requires wear >= limit
//   max    - per-shift budget; each applied CHANGE/RESET consumes 1
//   window - virtual-clock expiry window for MEASURE (now - sent > window => stale)
function run(ops, options) {
  const { limit, max } = options;
  const window = options.window === undefined ? Infinity : options.window;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive number');
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a non-negative integer');
  if (!Array.isArray(ops)) throw new Error('ops must be an array');

  const tools = new Map(); // name -> { wear }
  const confirmed = new Set(); // seqs already applied (retransmission dedup)
  let maxSeq = -Infinity;
  let activeTool = null;
  let pendingChange = null; // { tool, seq } until a MEASURE for the new tool acks it
  let budgetUsed = 0;
  let now = 0;

  const curve = [];
  const alarms = [];
  const rejections = [];
  const evidence = [];
  let violation = null;
  let budgetExceeded = false;

  const wearOf = (name) => (tools.has(name) ? tools.get(name).wear : 0);
  const ensureTool = (name) => {
    if (!tools.has(name)) tools.set(name, { wear: 0 });
    return tools.get(name);
  };
  const confirm = (seq) => {
    confirmed.add(seq);
    maxSeq = seq;
  };
  const snapshot = (op, note) => {
    curve.push({
      t: now,
      seq: op.seq,
      type: op.type,
      tool: activeTool,
      wear: activeTool === null ? 0 : wearOf(activeTool),
      note,
    });
  };

  for (const op of ops) {
    if (typeof op.t === 'number') now = Math.max(now, op.t);

    if (confirmed.has(op.seq)) {
      evidence.push({ t: now, seq: op.seq, type: op.type, kind: 'DUPLICATE',
        detail: 'retransmission ignored; already applied exactly once' });
      continue;
    }
    if (op.seq < maxSeq) {
      evidence.push({ t: now, seq: op.seq, type: op.type, kind: 'OUT_OF_ORDER',
        detail: `seq ${op.seq} older than confirmed seq ${maxSeq}; ignored, evidence retained` });
      continue;
    }

    if (op.type === 'MEASURE') {
      const sent = typeof op.sent === 'number' ? op.sent : (typeof op.t === 'number' ? op.t : now);
      if (now - sent > window) {
        evidence.push({ t: now, seq: op.seq, type: op.type, kind: 'EXPIRED',
          detail: `stale by ${now - sent} (> window ${window}); ignored, evidence retained` });
        confirm(op.seq);
        continue;
      }
      const st = ensureTool(op.tool);
      if (op.wear < st.wear) {
        violation = { t: now, seq: op.seq, tool: op.tool, previous: st.wear, reported: op.wear,
          detail: 'wear must be monotonically non-decreasing' };
        evidence.push({ t: now, seq: op.seq, type: op.type, kind: 'MONOTONIC_VIOLATION',
          detail: violation.detail });
        break;
      }
      st.wear = op.wear;
      confirm(op.seq);
      if (activeTool === null) activeTool = op.tool;
      if (pendingChange && op.tool === pendingChange.tool) {
        evidence.push({ t: now, seq: op.seq, type: op.type, kind: 'CHANGE_CONFIRMED',
          detail: `CHANGE seq ${pendingChange.seq} acknowledged by MEASURE for ${op.tool}` });
        pendingChange = null;
      }
      if (op.tool === activeTool && st.wear >= limit) {
        alarms.push({ t: now, seq: op.seq, tool: op.tool, wear: st.wear, kind: 'LIMIT_REACHED',
          detail: `wear ${st.wear} >= limit ${limit}` });
      }
      snapshot(op, 'applied');
      continue;
    }

    if (op.type === 'CHANGE') {
      if (budgetUsed >= max) {
        budgetExceeded = true;
        rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'BUDGET_EXCEEDED',
          detail: `budget ${budgetUsed}/${max} exhausted; rejected atomically, no state changed` });
        continue;
      }
      budgetUsed += 1;
      ensureTool(op.tool).wear = 0; // clear old tool
      activeTool = op.new; // bind new tool
      ensureTool(op.new).wear = 0;
      pendingChange = { tool: op.new, seq: op.seq };
      confirm(op.seq);
      snapshot(op, 'applied');
      continue;
    }

    if (op.type === 'RESET') {
      if (pendingChange) {
        rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'PENDING_CHANGE',
          detail: `unacknowledged CHANGE seq ${pendingChange.seq} for ${pendingChange.tool}` });
        continue;
      }
      if (op.tool !== activeTool) {
        rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'NOT_ACTIVE',
          detail: `tool ${op.tool} is not the active tool (${activeTool})` });
        continue;
      }
      const st = ensureTool(op.tool);
      if (st.wear < limit) {
        rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'BELOW_LIMIT',
          detail: `wear ${st.wear} < limit ${limit}` });
        continue;
      }
      if (budgetUsed >= max) {
        budgetExceeded = true;
        rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'BUDGET_EXCEEDED',
          detail: `budget ${budgetUsed}/${max} exhausted; rejected atomically, no state changed` });
        continue;
      }
      budgetUsed += 1;
      st.wear = 0;
      confirm(op.seq);
      snapshot(op, `applied by ${op.admin === undefined ? 'admin' : op.admin}`);
      continue;
    }

    rejections.push({ t: now, seq: op.seq, type: op.type, reason: 'UNKNOWN_OP',
      detail: `unknown op type ${op.type}` });
  }

  const exitCode = violation ? EXIT_MONOTONIC : budgetExceeded ? EXIT_BUDGET : EXIT_OK;
  return {
    limit,
    max,
    window,
    budgetUsed,
    activeTool,
    pendingChange,
    wear: activeTool === null ? 0 : wearOf(activeTool),
    tools: Object.fromEntries([...tools].map(([name, st]) => [name, st.wear])),
    curve,
    alarms,
    rejections,
    evidence,
    violation,
    exitCode,
  };
}

module.exports = { run, EXIT_OK, EXIT_BUDGET, EXIT_MONOTONIC };
