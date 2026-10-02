#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { AuditError } from './errors.js';
import { initLedger, appendEvents, snapshot, readTail, readState, verify, anchorInfo, cancelPayment, DEFAULT_WINDOW } from './ledger.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function usage() {
  return [
    'usage: node src/cli.js <command> <file> [args]',
    '  init     <file> [--window N]',
    '  append   <file> <eventJson>...   events: {"type":"pay","id","account","amount"}',
    '                                   {"type":"cancel","paymentId"} {"type":"limit","account","limit"}',
    '  snapshot <file>',
    '  tail     <file> --n K [--state 1]',
    '  verify   <file> [--to SEQ]',
    '  anchor   <file>',
    '  cancel   <file> <paymentId>',
  ].join('\n');
}

function dispatch(argv) {
  const [command, file, ...rest] = argv;
  if (!command || !file) throw new AuditError('USAGE', usage());
  const { flags, positional } = parseFlags(rest);
  switch (command) {
    case 'init':
      initLedger(file, flags.window ? Number(flags.window) : DEFAULT_WINDOW);
      return { file, window: flags.window ? Number(flags.window) : DEFAULT_WINDOW };
    case 'append': {
      if (positional.length === 0) throw new AuditError('NO_EVENTS', 'append requires at least one event JSON');
      const events = positional.map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          throw new AuditError('BAD_EVENT_JSON', `invalid event JSON: ${raw}`);
        }
      });
      return appendEvents(file, events);
    }
    case 'snapshot':
      return snapshot(file);
    case 'tail': {
      const n = Number(flags.n);
      if (!Number.isInteger(n) || n < 1) throw new AuditError('INVALID_ARGUMENT', `tail --n must be a positive integer, got: ${flags.n}`);
      const result = readTail(file, n);
      if (flags.state) result.state = readState(file);
      return result;
    }
    case 'verify':
      return verify(file, flags.to !== undefined ? Number(flags.to) : null);
    case 'anchor':
      return anchorInfo(file);
    case 'cancel': {
      const [paymentId] = positional;
      if (!paymentId) throw new AuditError('INVALID_ARGUMENT', 'cancel requires a paymentId');
      return cancelPayment(file, paymentId);
    }
    default:
      throw new AuditError('USAGE', usage());
  }
}

// In-process entry point: returns { status, stdout, stderr }.
export function runCli(argv) {
  try {
    const result = dispatch(argv);
    return { status: 0, stdout: `${JSON.stringify({ ok: true, ...result })}\n`, stderr: '' };
  } catch (err) {
    const auditErr = err instanceof AuditError ? err : new AuditError('INTERNAL', err.message);
    return { status: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: auditErr.toJSON() })}\n` };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { status, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = status;
}
