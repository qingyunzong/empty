import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Conflict, propose, finalize, correct, rollback, verify, report } from './ledger.js';

function parseInteger(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Conflict(`${name}_NOT_AN_INTEGER ${value}`);
  return n;
}

export function runCli(argv) {
  let stdout = '';
  let stderr = '';
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        options: { dir: { type: 'string', default: process.env.SETTLE_DIR ?? '.settle' } },
        allowPositionals: true,
      });
    } catch (err) {
      throw new Conflict(`BAD_ARGS ${err.message}`);
    }
    const { values, positionals } = parsed;
    const [command, ...args] = positionals;
    if (!command) throw new Conflict('NO_COMMAND');
    const store = new Store(values.dir);
    store.load();
    const print = (value) => {
      stdout += `${JSON.stringify(value, null, 2)}\n`;
    };

    switch (command) {
      case 'budget': {
        const [participant, amount] = args;
        if (!participant || amount === undefined) throw new Conflict('USAGE budget <participant> <amount>');
        const value = parseInteger(amount, 'BUDGET');
        if (value < 0) throw new Conflict('BUDGET_NEGATIVE');
        store.state.budgets[participant] = value;
        store.save();
        print({ budgets: store.state.budgets });
        break;
      }
      case 'propose': {
        const [id, from, to, amount] = args;
        if (!id || !from || !to || amount === undefined) {
          throw new Conflict('USAGE propose <id> <from> <to> <amount>');
        }
        propose(store, { id, from, to, amount: parseInteger(amount, 'AMOUNT') });
        store.save();
        print({ proposed: id, pending: [...store.state.pending].sort() });
        break;
      }
      case 'finalize': {
        const block = finalize(store);
        store.save();
        print({ level: block.level, hash: block.hash, crc: block.crc, transfers: block.transfers });
        break;
      }
      case 'correct': {
        if (args.length !== 1) throw new Conflict('USAGE correct <level>');
        const { block, rolled } = correct(store, parseInteger(args[0], 'LEVEL'));
        store.save();
        print({
          level: block.level,
          hash: block.hash,
          crc: block.crc,
          transfers: block.transfers,
          rolledBack: rolled.map((b) => ({ level: b.level, hash: b.hash })),
        });
        break;
      }
      case 'rollback': {
        if (args.length !== 1) throw new Conflict('USAGE rollback <level>');
        const rolled = rollback(store, parseInteger(args[0], 'LEVEL'));
        store.save();
        print({ rolledBack: rolled.map((b) => ({ level: b.level, hash: b.hash })) });
        break;
      }
      case 'verify': {
        const issues = verify(store);
        if (issues.length > 0) {
          for (const issue of issues) stdout += `${issue.code} ${issue.hash} ${issue.detail}\n`;
          return { code: 2, stdout, stderr };
        }
        stdout += 'OK\n';
        break;
      }
      case 'state': {
        print(report(store));
        break;
      }
      default:
        throw new Conflict(`UNKNOWN_COMMAND ${command}`);
    }
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (err instanceof Conflict) {
      stderr += `CONFLICT ${err.message}\n`;
      return { code: 1, stdout, stderr };
    }
    throw err;
  }
}
