#!/usr/bin/env node
import fs from 'node:fs';
import { EventLog } from '../src/log.js';
import { Decoder } from '../src/decoder.js';
import { issueCertificate, verifyCertificate } from '../src/certificate.js';
import { LogError } from '../src/errors.js';

const USAGE = `evlog - offline append-only device event log

usage: evlog <command> <file> [options]

commands:
  append   <file> --device D --status N [--payload S] [--ts MS]
  correct  <file> --seq N --reason S [--device D] [--status N] [--payload S] [--ts MS]
  revoke   <file> --seq N --reason S [--ts MS]
  view     <file>                     active view (JSON)
  history  <file>                     full audit history (JSON)
  certify  <file> --seq N             certificate for the active correction of seq
  verify   <file> --cert JSON|@path   verify a certificate against the log
  rebuild-index <file>                discard tail index and rebuild by full scan
`;

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new LogError('E_USAGE', `missing value for --${key}`);
      opts[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function int(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new LogError('E_USAGE', `--${name} must be an integer`);
  return n;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const { positional, opts } = parseArgs(rest);
  const file = positional[0];
  if (!file) throw new LogError('E_USAGE', 'missing log file');

  switch (command) {
    case 'append': {
      const log = EventLog.open(file);
      try {
        const seq = log.append({
          device: opts.device,
          status: int(opts.status, 'status'),
          payload: opts.payload ?? '',
          ts: opts.ts !== undefined ? int(opts.ts, 'ts') : undefined,
        });
        log.flush();
        print({ seq });
      } finally {
        log.close();
      }
      return 0;
    }
    case 'correct': {
      const log = EventLog.open(file);
      try {
        const seq = log.correct({
          seq: int(opts.seq, 'seq'),
          reason: opts.reason,
          device: opts.device,
          status: opts.status !== undefined ? int(opts.status, 'status') : undefined,
          payload: opts.payload,
          ts: opts.ts !== undefined ? int(opts.ts, 'ts') : undefined,
        });
        log.flush();
        print({ seq });
      } finally {
        log.close();
      }
      return 0;
    }
    case 'revoke': {
      const log = EventLog.open(file);
      try {
        const seq = log.revoke({
          seq: int(opts.seq, 'seq'),
          reason: opts.reason,
          ts: opts.ts !== undefined ? int(opts.ts, 'ts') : undefined,
        });
        log.flush();
        print({ seq });
      } finally {
        log.close();
      }
      return 0;
    }
    case 'view': {
      print(new Decoder(file).update().view());
      return 0;
    }
    case 'history': {
      print(new Decoder(file).update().history());
      return 0;
    }
    case 'certify': {
      const decoder = new Decoder(file).update();
      print(issueCertificate(decoder, int(opts.seq, 'seq')));
      return 0;
    }
    case 'verify': {
      if (!opts.cert) throw new LogError('E_USAGE', 'missing --cert');
      const json = opts.cert.startsWith('@')
        ? fs.readFileSync(opts.cert.slice(1), 'utf8')
        : opts.cert;
      const decoder = new Decoder(file).update();
      const ok = verifyCertificate(decoder, JSON.parse(json));
      print({ ok });
      return ok ? 0 : 1;
    }
    case 'rebuild-index': {
      // Reopen after truncating away the tail index; open() rebuilds by scan.
      const log = EventLog.open(file);
      log.close();
      print({ ok: true, entries: log.index.size });
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      throw new LogError('E_USAGE', `unknown command: ${command}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof LogError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
