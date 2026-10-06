'use strict';

const INPUT_ERROR = 2;

class ToolLifeError extends Error {
  constructor(message, code = INPUT_ERROR) {
    super(message);
    this.name = 'ToolLifeError';
    this.code = code;
  }
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

class Ledger {
  constructor(toolsConfig) {
    if (!toolsConfig || !Array.isArray(toolsConfig.tools)) {
      throw new ToolLifeError('tools.json must contain a "tools" array');
    }
    this.tools = new Map();
    for (const t of toolsConfig.tools) {
      if (!t || typeof t.tool_id !== 'string' || typeof t.max_life !== 'number') {
        throw new ToolLifeError('each tool needs tool_id (string) and max_life (number)');
      }
      if (this.tools.has(t.tool_id)) {
        throw new ToolLifeError(`duplicate tool_id in tools.json: ${t.tool_id}`);
      }
      this.tools.set(t.tool_id, {
        tool_id: t.tool_id,
        max_life: t.max_life,
        materials: t.materials || {},
        remaining_life: t.max_life,
      });
    }
    this.history = [];
    this.seq = 0;
    this.seenOps = new Set();
    this.opIndex = new Map();
    this.toolOps = new Map();
    this.usedUndoIds = new Set();
    this.undoneOps = new Set();
  }

  _record(rec) {
    this.seq += 1;
    const entry = { seq: this.seq, ...rec };
    this.history.push(entry);
    return entry;
  }

  _tool(op) {
    const tool = this.tools.get(op.tool_id);
    if (!tool) throw new ToolLifeError(`unknown tool: ${op.tool_id}`);
    return tool;
  }

  applyOperation(op) {
    if (!op || typeof op.op_id !== 'string' || typeof op.type !== 'string') {
      throw new ToolLifeError('operation requires op_id and type');
    }
    const tool = this._tool(op);
    const base = { kind: 'op', op_id: op.op_id, type: op.type, tool_id: op.tool_id };

    if (this.seenOps.has(op.op_id)) {
      return this._record({ ...base, result: 'noop', reason: 'duplicate op_id' });
    }
    this.seenOps.add(op.op_id);

    let entry;
    if (op.type === 'setup') {
      tool.remaining_life = tool.max_life;
      entry = this._record({ ...base, result: 'applied', remaining_after: round6(tool.remaining_life) });
    } else if (op.type === 'cut') {
      if (tool.remaining_life < 0) {
        return this._record({
          ...base, result: 'rejected',
          reason: 'tool OVERUSE: cut forbidden until regrind or setup (replace)',
          remaining_after: round6(tool.remaining_life),
        });
      }
      const coeff = tool.materials[op.material];
      if (typeof coeff !== 'number') {
        throw new ToolLifeError(`unknown material "${op.material}" for tool ${op.tool_id}`);
      }
      const units = typeof op.units === 'number' ? op.units : 1;
      const deducted = round6(units * coeff);
      tool.remaining_life = round6(tool.remaining_life - deducted);
      entry = this._record({
        ...base, result: 'applied', material: op.material, units,
        coefficient: coeff, deducted,
        remaining_after: round6(tool.remaining_life),
        ...(tool.remaining_life < 0 ? { flag: 'OVERUSE' } : {}),
      });
    } else if (op.type === 'regrind') {
      const amount = typeof op.amount === 'number' ? op.amount : 0;
      const before = tool.remaining_life;
      tool.remaining_life = round6(Math.min(tool.max_life, tool.remaining_life + amount));
      entry = this._record({
        ...base, result: 'applied', requested: amount,
        restored: round6(tool.remaining_life - before),
        remaining_after: round6(tool.remaining_life),
      });
    } else {
      throw new ToolLifeError(`unknown op type: ${op.type}`);
    }

    this.opIndex.set(op.op_id, entry);
    if (!this.toolOps.has(op.tool_id)) this.toolOps.set(op.tool_id, []);
    this.toolOps.get(op.tool_id).push({ op_id: op.op_id, seq: entry.seq, type: op.type, status: 'active' });
    return entry;
  }

  applyUndo(undo) {
    if (!undo || typeof undo.undo_id !== 'string' || typeof undo.op_id !== 'string') {
      throw new ToolLifeError('undo requires undo_id and op_id');
    }
    const base = { kind: 'undo', undo_id: undo.undo_id, op_id: undo.op_id };

    if (this.usedUndoIds.has(undo.undo_id)) {
      return this._record({ ...base, result: 'noop', reason: 'duplicate undo_id' });
    }

    const target = this.opIndex.get(undo.op_id);
    if (!target || target.type !== 'cut' || target.result !== 'applied') {
      return this._record({ ...base, result: 'rejected', reason: 'op is not an applied cut' });
    }
    const tool = this.tools.get(target.tool_id);
    const full = { ...base, tool_id: tool.tool_id };

    if (this.undoneOps.has(undo.op_id)) {
      this.usedUndoIds.add(undo.undo_id);
      return this._record({ ...full, result: 'noop', reason: 'op already undone or compensated' });
    }

    const chain = this.toolOps.get(tool.tool_id) || [];
    const blockers = chain
      .filter((e) => e.seq > target.seq && e.status === 'active')
      .map((e) => e.op_id);
    const link = chain.find((e) => e.op_id === undo.op_id);

    if (blockers.length === 0) {
      tool.remaining_life = round6(tool.remaining_life + target.deducted);
      link.status = 'undone';
      this.undoneOps.add(undo.op_id);
      this.usedUndoIds.add(undo.undo_id);
      return this._record({
        ...full, result: 'applied', restored: target.deducted,
        remaining_after: round6(tool.remaining_life),
      });
    }

    const compId = `comp:${undo.undo_id}`;
    tool.remaining_life = round6(tool.remaining_life + target.deducted);
    link.status = 'compensated';
    this.undoneOps.add(undo.op_id);
    this.usedUndoIds.add(undo.undo_id);
    this.seenOps.add(compId);
    const undoEntry = this._record({
      ...full, result: 'compensated', compensate_op_id: compId, blocked_by: blockers,
    });
    this._record({
      kind: 'compensate_op', op_id: compId, tool_id: tool.tool_id,
      reverses: undo.op_id, amount: target.deducted,
      remaining_after: round6(tool.remaining_life),
    });
    return undoEntry;
  }

  state() {
    const tools = {};
    for (const [id, t] of [...this.tools.entries()].sort()) {
      tools[id] = {
        tool_id: id,
        max_life: t.max_life,
        remaining_life: round6(t.remaining_life),
        status: t.remaining_life < 0 ? 'OVERUSE' : 'OK',
      };
    }
    return { tools };
  }
}

function runToollife(toolsConfig, operations, undos) {
  const ledger = new Ledger(toolsConfig);
  for (const op of operations) ledger.applyOperation(op);
  for (const undo of undos || []) ledger.applyUndo(undo);
  return ledger;
}

module.exports = { Ledger, ToolLifeError, runToollife, INPUT_ERROR };
