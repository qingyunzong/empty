import { AuditLedger } from './ledger.js';

// A session wraps one AuditLedger and maps NDJSON command lines to NDJSON
// response lines. Kept separate from cli.js so the command surface is
// testable in-process.
export function createSession(ledger = new AuditLedger()) {
  const dispatch = (msg) => {
    switch (msg.cmd) {
      case 'addItem':
        return ledger.addItem(msg);
      case 'audit':
        return ledger.audit(msg);
      case 'correct':
        return ledger.correct(msg);
      case 'bound':
        return ledger.bound(msg);
      case 'explain':
        return ledger.explain();
      default:
        const err = new Error(`unknown command: ${msg.cmd}`);
        err.code = 'E_CMD';
        throw err;
    }
  };

  return {
    ledger,
    handleLine(line) {
      try {
        return { ok: true, result: dispatch(JSON.parse(line)) };
      } catch (err) {
        return {
          ok: false,
          error: { code: err.code ?? 'E_INTERNAL', message: String(err.message ?? err) },
        };
      }
    },
  };
}
