export { CODES, ReconError } from './src/errors.js';
export { stableStringify, sha256hex } from './src/canon.js';
export {
  DIFF_KINDS,
  validateEntry,
  classifyDiffs,
  classifyDiffsReference,
  diffsToTasks,
  applyRepair,
} from './src/diff.js';
export { History, compareEvents } from './src/history.js';
export { Scheduler, compareTasks } from './src/scheduler.js';
export { AuditLog } from './src/audit.js';
export { Journal } from './src/journal.js';
export { RepairEngine, serializeSnapshot, deserializeSnapshot } from './src/engine.js';
export { run } from './src/cli.js';
