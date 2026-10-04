import { Store } from './store.js';
import { traceRecall } from './recall.js';
import { parseUtc } from './timeutil.js';
import { RecallError } from './intervals.js';

function execOp(store, op, index) {
  try {
    switch (op.op) {
      case 'addBatch':
        store.addBatch(op);
        return { index, op: op.op, ok: true };
      case 'addRecord':
        store.addRecord(op);
        return { index, op: op.op, ok: true };
      case 'correctRecord':
        store.correctRecord(op);
        return { index, op: op.op, ok: true };
      case 'snapshot':
        store.snapshot(op.name);
        return { index, op: op.op, ok: true };
      case 'rollback':
        store.rollback(op.name);
        return { index, op: op.op, ok: true };
      case 'recall': {
        const results = traceRecall(
          store,
          op.defect,
          parseUtc(op.observeStart),
          parseUtc(op.observeEnd),
          op.snapshot ?? null,
        );
        return { index, op: op.op, ok: true, results };
      }
      default:
        throw new RecallError('UNKNOWN_OP', `unknown op: ${op.op}`);
    }
  } catch (err) {
    return {
      index,
      op: op && op.op ? op.op : null,
      ok: false,
      error: { code: err.code || 'INTERNAL', message: err.message },
    };
  }
}

export function runOps(ops) {
  if (!Array.isArray(ops)) throw new RecallError('INVALID_INPUT', 'input must be an array of ops or {ops:[...]}');
  const store = new Store();
  return ops.map((op, index) => execOp(store, op, index));
}
