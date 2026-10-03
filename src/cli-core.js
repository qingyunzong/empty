import { Scheduler } from './scheduler.js';

export function runSpec(spec) {
  const scheduler = new Scheduler(spec.horizon ?? 0);
  const results = [];

  for (const op of spec.ops ?? []) {
    try {
      switch (op.op) {
        case 'addRule':
          scheduler.addRule(op);
          results.push({ op: op.op, id: op.id, ok: true });
          break;
        case 'updateRule':
          scheduler.updateRule(op.id, op);
          results.push({ op: op.op, id: op.id, ok: true });
          break;
        case 'removeRule':
          scheduler.removeRule(op.id);
          results.push({ op: op.op, id: op.id, ok: true });
          break;
        case 'addReservation':
          scheduler.addReservation(op);
          results.push({ op: op.op, id: op.id, ok: true });
          break;
        case 'override':
          scheduler.override(op.high, op.low, { permit: op.permit });
          results.push({ op: op.op, ok: true, overrides: scheduler.state().overrides });
          break;
        case 'undo':
          results.push({ op: op.op, ok: scheduler.undo() });
          break;
        case 'redo':
          results.push({ op: op.op, ok: scheduler.redo() });
          break;
        case 'enumerate':
          results.push({ op: op.op, instances: scheduler.enumerateInstances(op.ruleId) });
          break;
        case 'check':
          results.push({ op: op.op, checks: op.id ? [scheduler.checkReservation(op.id)] : scheduler.checkAll() });
          break;
        case 'state':
          results.push({ op: op.op, state: scheduler.state() });
          break;
        default:
          results.push({ op: op.op, ok: false, error: 'unknown op' });
      }
    } catch (err) {
      results.push({ op: op.op, id: op.id, ok: false, error: err.message });
    }
  }

  return JSON.parse(JSON.stringify(results));
}
