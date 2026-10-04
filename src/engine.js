'use strict';

class UnknownToolError extends Error {
  constructor(toolId) {
    super(`unknown tool: ${toolId}`);
    this.name = 'UnknownToolError';
    this.code = 'UNKNOWN_TOOL';
    this.toolId = toolId;
  }
}

// Pure, deterministic tool-life engine.
// config:      { materials: {name: coef}, tools: [{tool_id, max_life, life?}] }
// operations:  [{op_id, tool_id, type: 'setup'|'cut'|'regrind', material?, amount?, restore?}]
// undoRequests:[{undo_id?, op_id}]
// Returns { toolsState, history }.
function runToollife(config, operations, undoRequests) {
  if (!config || typeof config !== 'object') throw new TypeError('config object required');
  const materials = config.materials || {};
  const tools = new Map();
  for (const t of config.tools || []) {
    if (!t || typeof t.tool_id !== 'string') throw new TypeError('each tool needs a tool_id');
    if (typeof t.max_life !== 'number') throw new TypeError(`tool ${t.tool_id} needs numeric max_life`);
    tools.set(t.tool_id, {
      tool_id: t.tool_id,
      max_life: t.max_life,
      life: t.life === undefined ? t.max_life : t.life,
    });
  }

  const history = [];
  let seq = 0;
  const record = (entry) => {
    history.push(Object.assign({ seq: seq++ }, entry));
  };

  const requireTool = (toolId) => {
    const tool = tools.get(toolId);
    if (!tool) throw new UnknownToolError(toolId);
    return tool;
  };

  const opById = new Map(); // op_id -> internal record

  // Phase 1: apply operations in order. Replay of an op_id is idempotent (NOOP).
  operations.forEach((op, index) => {
    const tool = requireTool(op.tool_id);
    if (opById.has(op.op_id)) {
      record({
        kind: 'op', op_id: op.op_id, tool_id: op.tool_id, type: op.type,
        status: 'NOOP', reason: 'duplicate_op_id', life_after: tool.life,
      });
      return;
    }
    const rec = {
      op_id: op.op_id, tool_id: op.tool_id, type: op.type,
      deduction: 0, active: false, undone: false, compensated: false, order: index,
    };
    opById.set(op.op_id, rec);

    if (op.type === 'setup') {
      tool.life = tool.max_life;
      rec.active = true;
      record({ kind: 'op', op_id: op.op_id, tool_id: op.tool_id, type: 'setup', status: 'APPLIED', life_after: tool.life });
    } else if (op.type === 'cut') {
      const coef = materials[op.material] === undefined ? 1 : materials[op.material];
      const deduction = op.amount * coef;
      rec.deduction = deduction;
      if (tool.life < 0) {
        // OVERUSE state: further cuts forbidden until regrind or setup.
        record({
          kind: 'op', op_id: op.op_id, tool_id: op.tool_id, type: 'cut',
          status: 'BLOCKED_OVERUSE', deduction, life_after: tool.life,
        });
      } else {
        tool.life -= deduction; // forced even if it drives life negative
        rec.active = true;
        record({
          kind: 'op', op_id: op.op_id, tool_id: op.tool_id, type: 'cut',
          status: tool.life < 0 ? 'OVERUSE' : 'APPLIED', deduction, life_after: tool.life,
        });
      }
    } else if (op.type === 'regrind') {
      tool.life = Math.min(tool.max_life, tool.life + op.restore);
      rec.active = true;
      record({
        kind: 'op', op_id: op.op_id, tool_id: op.tool_id, type: 'regrind',
        status: 'APPLIED', restored: op.restore, life_after: tool.life,
      });
    } else {
      throw new Error(`unknown op type: ${op.type}`);
    }
  });

  // Phase 2: undo requests. Undo + compensation are paired and apply at most once.
  const processedUndoKeys = new Set();
  for (const u of undoRequests || []) {
    const key = u.undo_id === undefined ? `undo:${u.op_id}` : u.undo_id;
    const base = { kind: 'undo', undo_id: key, op_id: u.op_id };
    if (processedUndoKeys.has(key)) {
      record(Object.assign({}, base, { status: 'NOOP', reason: 'duplicate_undo' }));
      continue;
    }
    processedUndoKeys.add(key);

    const rec = opById.get(u.op_id);
    if (!rec) {
      record(Object.assign({}, base, { status: 'REJECTED', reason: 'unknown_op' }));
      continue;
    }
    const tool = tools.get(rec.tool_id);
    const withTool = Object.assign({}, base, { tool_id: rec.tool_id });

    if (rec.undone || rec.compensated) {
      record(Object.assign({}, withTool, { status: 'NOOP', reason: 'already_reversed', life_after: tool.life }));
      continue;
    }
    if (rec.type !== 'cut') {
      record(Object.assign({}, withTool, { status: 'REJECTED', reason: 'not_undoable', life_after: tool.life }));
      continue;
    }
    if (!rec.active) {
      record(Object.assign({}, withTool, { status: 'REJECTED', reason: 'not_applied', life_after: tool.life }));
      continue;
    }

    // Dependency: any later still-active op on the same tool blocks direct reversal.
    let dependent = false;
    for (const other of opById.values()) {
      if (
        other.tool_id === rec.tool_id &&
        other.order > rec.order &&
        other.active && !other.undone && !other.compensated
      ) {
        dependent = true;
        break;
      }
    }

    rec.active = false;
    if (!dependent) {
      rec.undone = true;
      tool.life += rec.deduction; // exact inverse; nothing happened in between
      record(Object.assign({}, withTool, { status: 'UNDONE', life_after: tool.life }));
    } else {
      rec.compensated = true;
      tool.life = Math.min(tool.max_life, tool.life + rec.deduction);
      record(Object.assign({}, withTool, { status: 'COMPENSATED', reason: 'dependency', life_after: tool.life }));
      record({
        kind: 'compensate_op', compensate_id: `cmp:${key}`, op_id: rec.op_id,
        tool_id: rec.tool_id, amount: rec.deduction, status: 'APPLIED', life_after: tool.life,
      });
    }
  }

  const toolsState = [...tools.values()].map((t) => ({
    tool_id: t.tool_id,
    max_life: t.max_life,
    life: t.life,
    overused: t.life < 0,
  }));
  return { toolsState, history };
}

module.exports = { runToollife, UnknownToolError };
