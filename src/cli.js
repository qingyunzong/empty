#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Ledger } from './ledger.js';
import { LedgerError } from './errors.js';

function usage() {
  throw new LedgerError(
    'USAGE',
    'usage: cli.js <append|cancel|snapshot|tail|verify|anchor> <file> [args]',
    null,
  );
}

export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    main(argv, io);
    return 0;
  } catch (error) {
    const err = error instanceof LedgerError ? error : new LedgerError('INTERNAL', error.message, null);
    const body = { ok: false, error: { code: err.code, range: err.range, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    io.stderr(`${JSON.stringify(body)}\n`);
    return 1;
  }
}

function main(argv, io) {
  const printOk = (value) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  const [command, file, ...rest] = argv;
  if (!command || !file) usage();
  const ledger = new Ledger(file);
  switch (command) {
    case 'append': {
      if (rest.length !== 1) usage();
      let parsed;
      try {
        parsed = JSON.parse(rest[0]);
      } catch {
        throw new LedgerError('BAD_EVENT', 'events argument is not valid JSON', null);
      }
      const events = Array.isArray(parsed) ? parsed : [parsed];
      const result = ledger.appendEvents(events);
      printOk({
        ok: true,
        range: [result.startSeq, result.endSeq],
        events: events.length,
        block: { offset: result.offset, hash: result.hash },
      });
      return;
    }
    case 'cancel': {
      if (rest.length !== 1) usage();
      const result = ledger.appendEvents([{ type: 'cancel', paymentId: rest[0] }]);
      printOk({
        ok: true,
        range: [result.startSeq, result.endSeq],
        events: 1,
        block: { offset: result.offset, hash: result.hash },
      });
      return;
    }
    case 'snapshot': {
      printOk({ ok: true, anchor: ledger.snapshot() });
      return;
    }
    case 'tail': {
      const nIndex = rest.indexOf('--n');
      if (nIndex === -1 || rest[nIndex + 1] === undefined) usage();
      printOk({ ok: true, ...ledger.tail(Number(rest[nIndex + 1])) });
      return;
    }
    case 'verify': {
      printOk({ ok: true, ...ledger.verify() });
      return;
    }
    case 'anchor': {
      printOk({ ok: true, ...ledger.latestAnchor() });
      return;
    }
    default:
      usage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
