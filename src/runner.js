import { parseDag } from './dag.js';
import { ReadySet } from './ready.js';
import { saveState, writeCheckpoint, verifyCheckpoints } from './state.js';

// Deterministic simulated executor.
// - tasks run one at a time in ReadySet (lexicographic) order
// - a task fails its first `failAttempts` attempts, then succeeds
// - each attempt is retried up to `retries` times, then the task is given up
// - before being marked complete a task writes a checkpoint; a task with
//   crash: "after-checkpoint" crashes the run right there
// - on resume, a checkpointed task is NOT re-executed (no repeated side
//   effects); it is marked complete from its checkpoint
export function execute(statePath, state) {
  const tasks = parseDag(state.dag);
  verifyCheckpoints(statePath, state);
  const ready = new ReadySet(tasks, state.plan, new Set(state.completed));
  const log = state.log;

  while (ready.size > 0) {
    const id = ready.peek();
    if (id === undefined) break; // rest blocked by failed dependencies
    const t = tasks.get(id);

    if (state.checkpointed.includes(id)) {
      log.push(`RESUME ${id}`);
    } else {
      const attempt = (state.attempts[id] ?? 0) + 1;
      state.attempts[id] = attempt;
      if (attempt <= t.failAttempts) {
        log.push(`FAIL ${id} ${attempt}`);
        if (attempt > t.retries) {
          state.failed.push(id);
          ready.drop(id);
          log.push(`GIVEUP ${id}`);
        }
        saveState(statePath, state);
        continue;
      }
      log.push(`EXEC ${id}`);
      writeCheckpoint(statePath, state, id);
      log.push(`CKPT ${id}`);
      if (t.crash === 'after-checkpoint') {
        saveState(statePath, state);
        return { status: 'crashed', task: id, state };
      }
    }
    state.completed.push(id);
    log.push(`DONE ${id}`);
    ready.complete(id);
    saveState(statePath, state);
  }

  for (const id of state.plan) {
    if (!state.completed.includes(id) && !state.failed.includes(id) && !state.skipped.includes(id)) {
      state.skipped.push(id);
      log.push(`SKIP ${id}`);
    }
  }
  saveState(statePath, state);
  return { status: state.failed.length > 0 ? 'failed' : 'done', state };
}
