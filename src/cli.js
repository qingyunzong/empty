'use strict';

const { FactoringStore, FactoringError } = require('./store.js');

const USAGE = `Usage: cli.js <command> [options]

Commands:
  init      --file PATH --credit-line N [--slop K]     Create a new store file
  add       --file PATH --id ID --creditor C --face-value N --advance-rate R [--memo TEXT]
  revoke    --file PATH --id ID                        Revoke an invoice, print certificate
  get       --file PATH --id ID                        Show one invoice
  list      --file PATH                                List all invoices
  totals    --file PATH                                Show creditLine / frozen / available
  clusters  --file PATH                                List association clusters
  candidates --file PATH --id ID                       Ranked related invoices for an invoice

All output is JSON on stdout. Errors go to stderr with exit code 1.`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new FactoringError('BAD_ARGS', `missing value for --${key}`);
      }
      opts[key] = argv[++i];
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function num(opts, key) {
  if (opts[key] === undefined) {
    throw new FactoringError('BAD_ARGS', `missing required option --${key}`);
  }
  const value = Number(opts[key]);
  if (!Number.isFinite(value)) {
    throw new FactoringError('BAD_ARGS', `--${key} must be a number, got "${opts[key]}"`);
  }
  return value;
}

function str(opts, key) {
  if (opts[key] === undefined) {
    throw new FactoringError('BAD_ARGS', `missing required option --${key}`);
  }
  return opts[key];
}

function loadStore(opts) {
  return FactoringStore.load(str(opts, 'file'));
}

// Returns { code, stdout, stderr } without touching process streams.
function runCli(argv) {
  try {
    const opts = parseArgs(argv);
    const command = opts._.shift();
    let result;
    switch (command) {
      case 'init': {
        const store = new FactoringStore({
          creditLine: num(opts, 'credit-line'),
          slop: opts.slop === undefined ? 1 : num(opts, 'slop'),
          file: str(opts, 'file'),
        });
        store.save();
        result = { ok: true, file: store.file, creditLine: store.creditLine, slop: store.slop };
        break;
      }
      case 'add': {
        result = loadStore(opts).addInvoice({
          id: str(opts, 'id'),
          creditor: str(opts, 'creditor'),
          faceValue: num(opts, 'face-value'),
          advanceRate: num(opts, 'advance-rate'),
          memo: opts.memo === undefined ? '' : opts.memo,
        });
        break;
      }
      case 'revoke':
        result = loadStore(opts).revokeInvoice(str(opts, 'id'));
        break;
      case 'get':
        result = loadStore(opts).getInvoice(str(opts, 'id'));
        break;
      case 'list':
        result = loadStore(opts).listInvoices();
        break;
      case 'totals':
        result = loadStore(opts).totals();
        break;
      case 'clusters':
        result = loadStore(opts).clusters();
        break;
      case 'candidates':
        result = loadStore(opts).rankCandidates(str(opts, 'id'));
        break;
      case undefined:
      case 'help':
      case '--help':
        return { code: 0, stdout: USAGE + '\n', stderr: '' };
      default:
        throw new FactoringError('BAD_ARGS', `unknown command: ${command}`);
    }
    return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err instanceof FactoringError ? err.code : 'INTERNAL_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, stdout: '', stderr: `${code}: ${message}\n` };
  }
}

module.exports = { runCli, USAGE };
