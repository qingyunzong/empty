import { Planner, PlannerError } from './planner.js';

// Process a JSONL command stream, returning one result object per input line.
export function processJsonl(input) {
  const planner = new Planner();
  const results = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      results.push(planner.execute(JSON.parse(line)));
    } catch (err) {
      if (err instanceof PlannerError) {
        results.push({ ok: false, error: err.code, message: err.message });
      } else if (err instanceof SyntaxError) {
        results.push({ ok: false, error: 'INVALID_INPUT', message: 'invalid JSON line' });
      } else {
        results.push({ ok: false, error: 'INTERNAL', message: String(err?.message ?? err) });
      }
    }
  }
  return results;
}
