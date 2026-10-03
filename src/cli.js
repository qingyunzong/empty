import fs from 'node:fs';
import { openLog } from './log.js';
import { CODES, LogError } from './errors.js';

export const EXIT_CODES = Object.freeze({
  [CODES.QUOTA]: 2,
  [CODES.CORRUPT]: 3,
  [CODES.SEQ_GAP]: 4,
  [CODES.READONLY]: 5,
});

const USAGE = `usage:
  auditlog append  --dir DIR [--input FILE|-] [--rate T=N]... [--disk T=BYTES]...
                   [--priority T=N]... [--page-size N] [--capacity N] [--aging-rate N]
  auditlog recover --dir DIR
  auditlog verify  --dir DIR`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { quotas: {}, priorities: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case '--dir': opts.dir = next(); break;
      case '--input': opts.input = next(); break;
      case '--page-size': opts.pageSize = Number(next()); break;
      case '--capacity': opts.capacity = Number(next()); break;
      case '--aging-rate': opts.agingRate = Number(next()); break;
      case '--rate': {
        const [t, v] = next().split('=');
        (opts.quotas[t] ??= {}).ratePerSec = Number(v);
        break;
      }
      case '--disk': {
        const [t, v] = next().split('=');
        (opts.quotas[t] ??= {}).diskBytes = Number(v);
        break;
      }
      case '--priority': {
        const [t, v] = next().split('=');
        opts.priorities[t] = Number(v);
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return { opts, positional };
}

function readJsonl(input, readStdin) {
  const text = input && input !== '-' ? fs.readFileSync(input, 'utf8') : readStdin();
  const events = [];
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      violations.push({ code: CODES.CORRUPT, detail: `line ${i + 1}: invalid JSON` });
    }
  }
  return { events, violations };
}

// Runs the CLI. io = { readStdin(): string, writeOut(s), writeErr(s) }.
// Returns the process exit code (does not call process.exit).
export function runCli(argv, io) {
  try {
    return dispatch(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.writeErr(USAGE + '\n');
      return 1;
    }
    if (err instanceof LogError) {
      io.writeErr(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
      return EXIT_CODES[err.code] ?? 1;
    }
    io.writeErr(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }) + '\n');
    return 1;
  }
}

function dispatch(argv, io) {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError('missing command');
  const { opts } = parseArgs(rest);
  if (!opts.dir) throw new UsageError('missing --dir');

  const logOpts = {
    quotas: opts.quotas,
    priorities: opts.priorities,
    ...(opts.pageSize && { pageSize: opts.pageSize }),
    ...(opts.capacity && { capacity: opts.capacity }),
    ...(opts.agingRate != null && { agingRate: opts.agingRate }),
  };
  const print = (obj) => io.writeOut(JSON.stringify(obj, null, 2) + '\n');

  if (command === 'append') {
    const { events, violations: parseViolations } = readJsonl(opts.input, io.readStdin);
    const log = openLog(opts.dir, logOpts);
    const result = log.append(events);
    const perTenant = {};
    for (const event of result.events) perTenant[event.tenant] = (perTenant[event.tenant] ?? 0) + 1;
    print({
      command: 'append',
      stats: {
        input: events.length,
        appended: result.appended,
        pages: log.pageCount,
        lastSeq: log.lastSeq,
        perTenant,
      },
      root: result.root,
      violations: [...parseViolations, ...result.violations],
    });
    log.close();
    return 0;
  }

  if (command === 'recover') {
    const log = openLog(opts.dir, logOpts);
    const recovery = log.lastRecovery;
    print({
      command: 'recover',
      stats: {
        pages: recovery.pages,
        events: recovery.events,
        lastSeq: recovery.lastSeq,
        truncatedBytes: recovery.truncatedBytes,
        quarantinedBytes: recovery.quarantine?.length ?? 0,
      },
      root: log.root,
      violations: recovery.violations,
      quarantine: recovery.quarantine,
    });
    log.close();
    return 0;
  }

  if (command === 'verify') {
    const log = openLog(opts.dir, { ...logOpts, readonly: true });
    const result = log.verify();
    print({ command: 'verify', valid: result.valid, stats: result.stats, root: result.root, violations: result.violations });
    log.close();
    if (!result.valid) {
      const code = result.violations[0]?.code ?? CODES.CORRUPT;
      return EXIT_CODES[code] ?? 1;
    }
    return 0;
  }

  throw new UsageError(`unknown command: ${command}`);
}
