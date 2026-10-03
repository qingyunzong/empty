import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Ledger } from './ledger.js';
import { LedgerError } from './errors.js';

export const COMMANDS = ['init', 'add', 'prepare', 'commit', 'cancel', 'get', 'crash'];

// Runs one CLI invocation. Returns the exit code; all output goes through
// `io` so the function is testable in-process. State lives on disk, so each
// call is equivalent to a separate process (including WAL recovery).
export function main(argv, io) {
  const fail = (err) => {
    const body =
      err instanceof LedgerError
        ? err.toJSON()
        : { error: { code: 'INTERNAL_ERROR', message: String(err?.message ?? err) } };
    io.stderr(`${JSON.stringify(body)}\n`);
    return 1;
  };

  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        data: { type: 'string' },
        budget: { type: 'string' },
        amount: { type: 'string' },
        parent: { type: 'string' },
        id: { type: 'string' },
        'after-prepare': { type: 'string' },
      },
    });
  } catch (err) {
    return fail(err);
  }

  const { values, positionals } = args;
  const [command, ...rest] = positionals;
  const dir = values.data ?? process.env.SETTLE_DATA ?? './.settle';

  const required = (value, name) => {
    if (value === undefined || value === null || value === '') {
      throw new LedgerError('USAGE', `missing required argument: ${name}`, { command });
    }
    return value;
  };

  const store = new Store(dir);
  try {
    const ledger = new Ledger(store);
    let out;
    switch (command) {
      case 'init':
        out = ledger.initRoot(values.id ?? 'root', Number(required(values.budget, '--budget')));
        break;
      case 'add':
        out = ledger.addGroup(
          required(values.parent, '--parent'),
          required(values.id, '--id'),
          Number(required(values.amount, '--amount')),
        );
        break;
      case 'prepare':
        out = ledger.prepare(required(rest[0], 'ID'));
        break;
      case 'commit':
        out = ledger.commit(required(rest[0], 'ID'));
        break;
      case 'cancel':
        out = ledger.cancel(required(rest[0], 'ID'));
        break;
      case 'get':
        out = ledger.getView(required(rest[0], 'ID'));
        break;
      case 'crash': {
        const target = required(values['after-prepare'], '--after-prepare ID');
        const prepared = ledger.prepare(target);
        // Simulated crash: PREPARE is durably in the WAL, COMMIT never happens.
        io.stderr(
          `${JSON.stringify({ crash: { phase: 'after-prepare', id: target, txId: prepared.txId } })}\n`,
        );
        return 3;
      }
      default:
        throw new LedgerError('USAGE', `unknown command: ${command ?? '(none)'}`, {
          commands: COMMANDS,
        });
    }
    io.stdout(`${JSON.stringify(out, null, 2)}\n`);
    store.markCleanShutdown();
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) store.markCleanShutdown();
    return fail(err);
  }
}
