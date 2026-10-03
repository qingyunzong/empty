'use strict';

const { Store } = require('./store');
const { CalendarError, ERR } = require('./errors');
const { generateCalendar } = require('./calendar');
const { buildTimezoneTables } = require('./timezone');

// 事务帧：记录本事务（含已合并的内层事务）写入的 undo 日志与保存点。
// 保存点记录 undo 日志长度；回滚到保存点即逆向撤销该点之后的写入。
class TxFrame {
  constructor(id) {
    this.id = id;
    this.undos = [];
    this.savepoints = new Map();
  }
}

class Engine {
  constructor() {
    this.store = new Store();
    this.txStack = [];
    this.results = [];
  }

  currentTx() {
    return this.txStack[this.txStack.length - 1] || null;
  }

  recordUndo(undo) {
    const tx = this.currentTx();
    if (tx) tx.undos.push(undo);
  }

  rollbackFrame(frame) {
    for (let i = frame.undos.length - 1; i >= 0; i--) {
      this.store.applyUndo(frame.undos[i]);
    }
    frame.undos.length = 0;
    frame.savepoints.clear();
  }

  // ---- 命令 ----

  applyCommand(cmd) {
    const { id, resource, startMs, endMs, baseVersion = 0 } = cmd;
    if (!id || !resource) {
      throw new CalendarError(ERR.VALIDATION, 'command requires id and resource');
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new CalendarError(
        ERR.INTERVAL_INVERSION,
        `command ${id}: endMs (${endMs}) must be after startMs (${startMs})`,
        { commandId: id }
      );
    }
    if (cmd.type === 'override' && typeof cmd.status !== 'string') {
      throw new CalendarError(ERR.VALIDATION, `command ${id}: override requires status`);
    }

    const conflict = this.store.findConflict(resource, startMs, endMs, baseVersion);
    if (conflict) {
      return {
        type: 'command',
        id,
        status: 'rejected',
        reason: ERR.REVISION,
        certificate: {
          commandId: id,
          conflictWith: conflict.interval.commandId,
          firstOverlapMs: conflict.firstOverlapMs,
        },
      };
    }

    const version = this.store.nextVersion();
    if (cmd.type === 'occupy') {
      const iv = { start: startMs, end: endMs, status: cmd.status || 'occupied', commandId: id, version };
      this.recordUndo(this.store.insert(resource, iv));
    } else if (cmd.type === 'release') {
      this.recordUndo(this.store.subtract(resource, startMs, endMs));
    } else if (cmd.type === 'override') {
      this.recordUndo(this.store.subtract(resource, startMs, endMs));
      const iv = { start: startMs, end: endMs, status: cmd.status, commandId: id, version };
      this.recordUndo(this.store.insert(resource, iv));
    } else {
      throw new CalendarError(ERR.VALIDATION, `unknown command type ${cmd.type}`);
    }
    return { type: 'command', id, status: 'committed', version };
  }

  // ---- 事务 ----

  begin(op) {
    const frame = new TxFrame(op.tx || `tx${this.txStack.length + 1}`);
    this.txStack.push(frame);
    return { type: 'begin', tx: frame.id, depth: this.txStack.length, status: 'ok' };
  }

  commit() {
    const frame = this.currentTx();
    if (!frame) throw new CalendarError(ERR.NO_TRANSACTION, 'commit without begin');
    this.txStack.pop();
    const parent = this.currentTx();
    if (parent) {
      // 层级提交：内层写入并入外层，外层回滚会一并撤销。
      parent.undos.push(...frame.undos);
    }
    return { type: 'commit', tx: frame.id, status: 'ok' };
  }

  abort(reason, details) {
    const frame = this.currentTx();
    if (!frame) throw new CalendarError(ERR.NO_TRANSACTION, 'abort without begin');
    this.txStack.pop();
    this.rollbackFrame(frame); // 只回滚本事务已写入的区间
    return { type: 'abort', tx: frame.id, status: 'rolled-back', reason, ...(details ? { details } : {}) };
  }

  savepoint(op) {
    const frame = this.currentTx();
    if (!frame) throw new CalendarError(ERR.NO_TRANSACTION, 'savepoint outside transaction');
    frame.savepoints.set(op.name, frame.undos.length);
    return { type: 'savepoint', name: op.name, tx: frame.id, status: 'ok' };
  }

  rollback(op) {
    const frame = this.currentTx();
    if (!frame) throw new CalendarError(ERR.NO_TRANSACTION, 'rollback outside transaction');
    if (!frame.savepoints.has(op.to)) {
      // 未知保存点：硬错误，当前事务失败并回滚。
      throw new CalendarError(
        ERR.UNKNOWN_SAVEPOINT,
        `tx ${frame.id}: unknown savepoint ${op.to}`,
        { tx: frame.id, savepoint: op.to }
      );
    }
    const mark = frame.savepoints.get(op.to);
    for (let i = frame.undos.length - 1; i >= mark; i--) {
      this.store.applyUndo(frame.undos[i]);
    }
    frame.undos.length = mark;
    for (const [name, pos] of frame.savepoints) {
      if (pos > mark) frame.savepoints.delete(name);
    }
    return { type: 'rollback', tx: frame.id, to: op.to, status: 'ok' };
  }

  // ---- 流处理 ----

  processOp(op) {
    try {
      switch (op.type) {
        case 'occupy':
        case 'release':
        case 'override':
          return this.applyCommand(op);
        case 'begin':
          return this.begin(op);
        case 'commit':
          return this.commit();
        case 'abort':
          return this.abort(op.reason || 'aborted');
        case 'savepoint':
          return this.savepoint(op);
        case 'rollback':
          return this.rollback(op);
        default:
          throw new CalendarError(ERR.VALIDATION, `unknown op type ${op.type}`);
      }
    } catch (err) {
      if (!(err instanceof CalendarError)) throw err;
      // 硬错误：若处于事务中，当前（最内层）事务失败并仅回滚其写入；
      // 外层事务继续存活，可选择保留该内层失败并继续提交。
      const result = { type: op.type, status: 'error', error: err.code, message: err.message };
      if (err.details) result.details = err.details;
      if (this.currentTx()) {
        const aborted = this.abort(err.code, err.details);
        result.abortedTx = aborted.tx;
      }
      return result;
    }
  }

  run(stream) {
    for (const op of stream) this.results.push(this.processOp(op));
    // 流结束时仍未闭合的事务自动回滚。
    while (this.currentTx()) {
      this.results.push(this.abort('unclosed-transaction'));
    }
    return this.results;
  }
}

// 顶层入口：input = { timezones?, calendar?, calendarWindow?, stream }
function runInput(input) {
  const engine = new Engine();
  const setupErrors = [];
  if (input.calendar) {
    try {
      const tz = buildTimezoneTables(input.timezones || {});
      const win = input.calendarWindow || { fromUtcMs: -Infinity, toUtcMs: Infinity };
      const materialized = generateCalendar(input.calendar, tz, win.fromUtcMs, win.toUtcMs);
      for (const [resource, intervals] of materialized) {
        for (const iv of intervals) {
          // 日历基准区间版本为 0，永不与 baseVersion >= 0 的命令冲突。
          engine.store.insert(resource, { ...iv, commandId: 'calendar', version: 0 });
        }
      }
    } catch (err) {
      if (!(err instanceof CalendarError)) throw err;
      setupErrors.push({ status: 'error', error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
  }
  const results = engine.run(input.stream || []);
  const resources = {};
  for (const [name] of engine.store.resources) {
    resources[name] = { intervals: engine.store.snapshot(name) };
  }
  return {
    setupErrors,
    results,
    finalVersion: engine.store.version,
    resources,
  };
}

module.exports = { Engine, runInput };
