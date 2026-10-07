import { Planner, STATUS } from './planner.js';

export function dispatch(planner, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    return { status: STATUS.INVALID_INPUT, error: 'command must be a JSON object' };
  }
  const op = cmd.op ?? cmd.cmd;
  switch (op) {
    case 'add_task':
      return planner.addTask(cmd.id, cmd.dur, cmd.cost);
    case 'dep':
      return planner.dep(cmd.a, cmd.b);
    case 'group_begin':
      return planner.groupBegin();
    case 'group_end':
      return planner.groupEnd();
    case 'commit':
      return planner.commit();
    case 'rollback':
      return planner.rollback(cmd.level);
    case 'schedule':
      return planner.schedule(cmd.budget);
    default:
      return { status: STATUS.INVALID_INPUT, error: `unknown op: ${String(op)}` };
  }
}

/** Process JSONL text, return one JSON string per non-empty input line. */
export function runJsonl(text) {
  const planner = new Planner();
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      out.push(JSON.stringify({ status: STATUS.INVALID_INPUT, error: `line ${i + 1}: invalid JSON` }));
      continue;
    }
    let result;
    try {
      result = dispatch(planner, cmd);
    } catch (err) {
      result = { status: STATUS.INVALID_INPUT, error: String(err && err.message ? err.message : err) };
    }
    out.push(JSON.stringify(result));
  }
  return out;
}
