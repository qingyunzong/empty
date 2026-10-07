import { Store, loadLedger } from './store.js';
import { Ledger } from './ledger.js';
import { Frac } from './frac.js';
import { LedgerError } from './errors.js';

export const EXIT = { E_PARSE: 1, E_REF: 2, E_STATE: 3, E_IO: 4 };

export const USAGE = `usage:
  pay.js init    <file> --limit <num/den>
  pay.js apply   <file> '<json-event>'     # freeze|capture|void|reverse|branch|merge|checkout|undo
  pay.js state   <file>
  pay.js replay  <file>                    # full replay trace
  pay.js recover <file>                    # truncate to last complete checksum, print summary

exit codes: 1=E_PARSE 2=E_REF 3=E_STATE 4=E_IO 64=usage`;

// Pure-ish CLI entry: returns { code, stdout, stderr } so it can be driven
// in-process from tests as well as from bin/pay.js.
export function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const out = (obj) => {
    stdout += JSON.stringify(obj) + '\n';
  };
  const errOut = (obj) => {
    stderr += JSON.stringify(obj) + '\n';
  };

  const openLog = (file) => {
    if (!file) throw new LedgerError('E_PARSE', 'missing log file argument');
    const store = new Store(file);
    const { ledger, summary } = loadLedger(store);
    if (summary.truncated) errOut({ recovered: true, ...summary, records: undefined });
    return { store, ledger };
  };

  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case 'init': {
        const [file, ...rest] = args;
        const li = rest.indexOf('--limit');
        if (!file || li === -1 || rest[li + 1] === undefined) {
          throw new LedgerError('E_PARSE', 'usage: init <file> --limit <num/den>');
        }
        const limit = Frac.parse(rest[li + 1]);
        if (!limit.isPos()) throw new LedgerError('E_STATE', 'limit must be positive');
        new Store(file).init(limit);
        out({ ok: true, limit: limit.toString() });
        break;
      }
      case 'apply': {
        const [file, json] = args;
        let op;
        try {
          op = JSON.parse(json);
        } catch {
          throw new LedgerError('E_PARSE', `invalid JSON event: ${json}`);
        }
        const { store, ledger } = openLog(file);
        const res = ledger.apply(op); // throws before anything is appended
        store.append(op);
        out({ ok: true, ...res, state: ledger.snapshot() });
        break;
      }
      case 'state': {
        const { ledger } = openLog(args[0]);
        out(ledger.snapshot());
        break;
      }
      case 'replay': {
        const file = args[0];
        if (!file) throw new LedgerError('E_PARSE', 'missing log file argument');
        const store = new Store(file);
        const summary = store.recover();
        if (summary.truncated) errOut({ recovered: true, ...summary, records: undefined });
        if (summary.records.length === 0) {
          throw new LedgerError('E_IO', `log ${file} is empty or missing; run "init" first`);
        }
        const [init, ...ops] = summary.records;
        const ledger = new Ledger(Frac.parse(init.limit));
        const trace = ops.map((op) => {
          const res = ledger.apply(op);
          return { op, result: res, available: ledger.snapshot().available };
        });
        out({ limit: init.limit, events: ops.length, trace, state: ledger.snapshot() });
        break;
      }
      case 'recover': {
        const file = args[0];
        if (!file) throw new LedgerError('E_PARSE', 'missing log file argument');
        const summary = new Store(file).recover();
        out({ ...summary, records: undefined });
        break;
      }
      default:
        return { code: 64, stdout, stderr: stderr + USAGE + '\n' };
    }
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (e instanceof LedgerError) {
      errOut({ error: e.code, message: e.message, details: e.details ?? null });
      return { code: EXIT[e.code] ?? 1, stdout, stderr };
    }
    throw e;
  }
}
