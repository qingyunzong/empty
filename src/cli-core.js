import { Planner, CncError } from './planner.js';

function runOp(planner, op) {
  try {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new CncError('E_INVALID_INPUT', 'op must be an object');
    }
    switch (op.op) {
      case 'commit':
        return { ok: true, certificate: planner.commit(op) };
      case 'undo':
        return { ok: true, certificate: planner.undo() };
      case 'redo':
        return { ok: true, certificate: planner.redo() };
      case 'certificate':
        return { ok: true, certificate: planner.certificate };
      default:
        throw new CncError('E_INVALID_INPUT', `unknown op: ${String(op.op)}`);
    }
  } catch (err) {
    if (err instanceof CncError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    return { ok: false, error: { code: 'E_INTERNAL', message: String(err?.message ?? err) } };
  }
}

// Pure entry point: stdin text in, { output, exitCode } out.
export function runCli(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return {
      output: `${JSON.stringify({
        ok: false,
        results: [],
        error: { code: 'E_INVALID_INPUT', message: 'stdin is not valid JSON' },
      })}\n`,
      exitCode: 1,
    };
  }
  const ops = Array.isArray(input?.ops) ? input.ops : [input];
  const planner = new Planner();
  const results = ops.map((op) => runOp(planner, op));
  const ok = results.every((r) => r.ok);
  return { output: `${JSON.stringify({ ok, results })}\n`, exitCode: ok ? 0 : 1 };
}
