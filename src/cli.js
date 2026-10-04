import fs from 'node:fs';
import { BusinessError, CorruptionError, InjectedCrash } from './errors.js';
import { initDb, QualityStore, publicRecord } from './store.js';
import { validateCatalog } from './catalog.js';

export const USAGE = `qcs - offline quality-inspection station ledger

usage: qcs <command> [options]

commands:
  init     --db DIR [--catalog FILE]        create a new database
  report   --db DIR (--json JSON | --file FILE | stdin)   report a measurement
  correct  --db DIR (--json JSON | --file FILE | stdin)   correct an existing record
  status   --db DIR --lot LOT --test CODE   latest judgment for (lotId, testCode)
  history  --db DIR --lot LOT --test CODE   full traceability chain
  verify   --db DIR [--record ID]           verify certificate chain or one certificate
  recover  --db DIR                         recover from WAL and print summary

exit codes: 0 ok, 1 business error, 2 corruption, 3 injected crash
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 >= argv.length) throw new BusinessError('ERR_USAGE', `missing value for --${key}`);
      opts[key] = argv[i + 1];
      i += 1;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function readJsonInput(opts, stdin) {
  let raw;
  if (opts.json !== undefined) raw = opts.json;
  else if (opts.file !== undefined) raw = fs.readFileSync(opts.file, 'utf8');
  else raw = stdin;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BusinessError('ERR_USAGE', 'input is not valid JSON');
  }
}

function dispatch(argv, { stdin, env }) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') return USAGE;
  const dir = opts.db;
  if (!dir) throw new BusinessError('ERR_USAGE', '--db DIR is required');

  if (cmd === 'init') {
    let catalog;
    if (opts.catalog) {
      try {
        catalog = validateCatalog(JSON.parse(fs.readFileSync(opts.catalog, 'utf8')));
      } catch (err) {
        if (err instanceof BusinessError) throw err;
        throw new BusinessError('ERR_USAGE', `catalog file invalid: ${err.message}`);
      }
    }
    return `${JSON.stringify({ ok: true, ...initDb(dir, catalog) }, null, 2)}\n`;
  }

  const store = QualityStore.open(dir, { fault: env?.QCS_FAULT ?? null });

  switch (cmd) {
    case 'report': {
      const { record, deduplicated } = store.report(readJsonInput(opts, stdin));
      const status = store.status(record.lotId, record.testCode);
      return `${JSON.stringify({ ok: true, deduplicated, record: publicRecord(record), status }, null, 2)}\n`;
    }
    case 'correct': {
      const { record, deduplicated } = store.correct(readJsonInput(opts, stdin));
      const status = store.status(record.lotId, record.testCode);
      return `${JSON.stringify({ ok: true, deduplicated, record: publicRecord(record), status }, null, 2)}\n`;
    }
    case 'status': {
      if (!opts.lot || !opts.test) throw new BusinessError('ERR_USAGE', 'status requires --lot and --test');
      return `${JSON.stringify({ ok: true, ...store.status(opts.lot, opts.test) }, null, 2)}\n`;
    }
    case 'history': {
      if (!opts.lot || !opts.test) throw new BusinessError('ERR_USAGE', 'history requires --lot and --test');
      return `${JSON.stringify({ ok: true, ...store.history(opts.lot, opts.test) }, null, 2)}\n`;
    }
    case 'verify': {
      const result = opts.record ? store.verifyCertificate(opts.record) : store.verifyChain();
      return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
    }
    case 'recover': {
      return `${JSON.stringify({ ok: true, recovered: store.recovered, projection: store.projection() }, null, 2)}\n`;
    }
    default:
      throw new BusinessError('ERR_USAGE', `unknown command: ${cmd}`);
  }
}

// Runs one CLI invocation. Returns { code, stdout, stderr } and never exits
// the process, so it is testable in-process. `io.stdin` is used when a
// command reads JSON from standard input.
export function runCli(argv, io = {}) {
  try {
    const stdout = dispatch(argv, { stdin: io.stdin ?? '', env: io.env ?? {} });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    if (err instanceof InjectedCrash) {
      return { code: 3, stdout: '', stderr: '' }; // simulated sudden power loss
    }
    if (err instanceof CorruptionError) {
      return { code: 2, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n` };
    }
    if (err instanceof BusinessError) {
      return { code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n` };
    }
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: 'ERR_INTERNAL', message: String(err?.stack ?? err) } })}\n` };
  }
}
