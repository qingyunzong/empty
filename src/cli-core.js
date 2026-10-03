// Batch driver shared by the CLI wrapper and tests.

import { createHistory } from './history.js';

function runOp(history, op) {
  if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
    return { ok: false, error: 'E_OP', message: 'op must be an object with an "op" field' };
  }
  switch (op.op) {
    case 'import':
      return history.importEvent({ id: op.id, a: op.a, b: op.b, f: op.f });
    case 'correct':
      return history.correct(op.id, op.f);
    case 'constrain':
      return history.constrain(op.before, op.after);
    case 'compare':
      return history.compare(op.x, op.y);
    case 'linearize':
      return history.linearize(op.ids);
    case 'undo':
      return history.undo();
    case 'redo':
      return history.redo();
    case 'snapshot':
      return history.snapshot();
    default:
      return { ok: false, error: 'E_OP', message: `unknown op: ${op.op}` };
  }
}

export function runBatch(input) {
  const ops = Array.isArray(input) ? input : Array.isArray(input?.ops) ? input.ops : [input];
  const history = createHistory();
  const results = ops.map((op) => {
    try {
      return runOp(history, op);
    } catch (e) {
      return { ok: false, error: 'E_INTERNAL', message: String(e?.message ?? e) };
    }
  });
  return { results };
}

// rawText -> { line, exitCode }: the exact single stdout line and exit code.
export function runCli(rawText) {
  let input;
  try {
    input = JSON.parse(rawText);
  } catch {
    return {
      line: `${JSON.stringify({ error: 'E_PARSE', message: 'stdin is not valid JSON' })}\n`,
      exitCode: 1,
    };
  }
  return { line: `${JSON.stringify(runBatch(input))}\n`, exitCode: 0 };
}
