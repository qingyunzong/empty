import { Ledger } from './ledger.js';

// Returns a handler mapping one parsed JSON command to a response object.
export function createHandler(ledger = new Ledger()) {
  return function handle(msg) {
    const { cmd, ...args } = msg;
    switch (cmd) {
      case 'loadCurve': return { ok: true, ...ledger.loadCurve(args) };
      case 'post': return { ok: true, ...ledger.post(args) };
      case 'backdate': return { ok: true, ...ledger.backdate(args) };
      case 'undoPost': return { ok: true, ...ledger.undoPost(args) };
      case 'certify': return { ok: true, cert: ledger.certify(args) };
      case 'verify': return { ok: true, ...ledger.verify(args.cert) };
      case 'root': return { ok: true, stateRoot: ledger.stateRoot(), curveRoot: ledger.curveRoot };
      default: {
        const e = new Error(`unknown command: ${cmd}`);
        e.code = 'E_CMD';
        throw e;
      }
    }
  };
}

// Process one NDJSON line, never throwing.
export function handleLine(handle, line) {
  try {
    return handle(JSON.parse(line));
  } catch (e) {
    return { ok: false, error: { code: e.code || 'E_INTERNAL', message: e.message } };
  }
}
