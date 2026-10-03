import { Inspector } from './inspector.js';
import { E, QError } from './errors.js';

function applyCommand(insp, cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.op !== 'string') {
    throw new QError(E.VALIDATION, 'each command must be an object with an "op" string');
  }
  const decimals = cmd.decimals === undefined ? 3 : cmd.decimals;
  switch (cmd.op) {
    case 'setTolerance': {
      const r = insp.setTolerance(cmd.polygon);
      return { op: cmd.op, ...r };
    }
    case 'setCorrection': {
      const r = insp.setCorrection(cmd);
      const classifications = {};
      for (const p of insp.state().points) classifications[p.id] = p.classification;
      return { op: cmd.op, ...r, classifications };
    }
    case 'addPoint': {
      const r = insp.addPoint(cmd);
      return { op: cmd.op, ...r, judgment: insp.judgment(r.id, decimals) };
    }
    case 'undo':
    case 'redo': {
      const r = cmd.op === 'undo' ? insp.undo() : insp.redo();
      return { op: cmd.op, ...r };
    }
    case 'getState': {
      return { op: cmd.op, state: insp.state(decimals) };
    }
    default:
      throw new QError(E.VALIDATION, `unknown op "${cmd.op}"`);
  }
}

/**
 * Run the CLI protocol on a JSON input string. Returns { text, code } where
 * `text` is exactly one line of JSON (terminated by \n) and `code` is the
 * process exit code (0 = all commands succeeded, 1 = failure).
 */
export function runCli(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { text: `${JSON.stringify({ ok: false, error: { code: E.PARSE, message: 'stdin is not valid JSON' } })}\n`, code: 1 };
  }
  const commands = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.commands)
      ? parsed.commands
      : [parsed];
  const insp = new Inspector();
  const results = [];
  for (const cmd of commands) {
    try {
      results.push(applyCommand(insp, cmd));
    } catch (err) {
      const code = err instanceof QError ? err.code : E.INTERNAL;
      return { text: `${JSON.stringify({ ok: false, results, error: { code, message: err.message } })}\n`, code: 1 };
    }
  }
  return { text: `${JSON.stringify({ ok: true, results })}\n`, code: 0 };
}
