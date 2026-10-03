#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { EventLog, LogError } = require('./src/eventlog');

const EXIT_CODES = { E_USAGE: 2, E_CRC: 3, E_REVISION: 4, E_FORMAT: 5, E_INDEX: 6 };

const USAGE = `devlog - offline append-only device event log

usage: node cli.js <command> <file> [flags]

commands:
  append  <file> --device D --status N [--payload S] [--ts N]
  correct <file> --ref SEQ --reason S [--status N] [--payload S] [--ts N]
  revoke  <file> --ref SEQ --reason S [--ts N]
  view    <file> [--partial]
  audit   <file>
  get     <file> --seq N
  verify  <file> --cert <cert.json|inline-json>
  rebuild <file>
`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new LogError('E_USAGE', `unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'partial') {
      flags.partial = true;
    } else {
      if (i + 1 >= argv.length) throw new LogError('E_USAGE', `missing value for --${key}`);
      flags[key] = argv[++i];
    }
  }
  return flags;
}

function num(flags, name, { required = false } = {}) {
  if (flags[name] === undefined) {
    if (required) throw new LogError('E_USAGE', `--${name} is required`);
    return undefined;
  }
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) throw new LogError('E_USAGE', `--${name} must be a number`);
  return n;
}

function recToJson(r) {
  const o = { ...r };
  if (Buffer.isBuffer(o.payload)) o.payload = o.payload.toString('utf8');
  return o;
}

function main(argv, io) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    io.out(USAGE);
    return;
  }
  if (!file) throw new LogError('E_USAGE', 'log file path is required');
  const flags = parseFlags(rest);

  switch (cmd) {
    case 'append': {
      if (!flags.device) throw new LogError('E_USAGE', '--device is required');
      const log = EventLog.open(file);
      const seq = log.append({
        device: flags.device,
        status: num(flags, 'status') ?? 0,
        payload: flags.payload,
        ts: num(flags, 'ts'),
      });
      log.close();
      io.print({ seq });
      break;
    }
    case 'correct': {
      const log = EventLog.open(file);
      const result = log.correct(num(flags, 'ref', { required: true }), {
        reason: flags.reason,
        status: num(flags, 'status') ?? 0,
        payload: flags.payload,
        ts: num(flags, 'ts'),
      });
      log.close();
      io.print(result);
      break;
    }
    case 'revoke': {
      const log = EventLog.open(file);
      const result = log.revoke(num(flags, 'ref', { required: true }), {
        reason: flags.reason,
        ts: num(flags, 'ts'),
      });
      log.close();
      io.print(result);
      break;
    }
    case 'view': {
      const log = EventLog.open(file);
      if (flags.partial) {
        const { view, error } = log.safeView();
        io.print({ view: view.map(recToJson), error: error ? error.code : null });
      } else {
        io.print(log.view().map(recToJson));
      }
      break;
    }
    case 'audit': {
      const log = EventLog.open(file);
      io.print(log.audit().map(recToJson));
      break;
    }
    case 'get': {
      const log = EventLog.open(file);
      const rec = log.getRecord(num(flags, 'seq', { required: true }));
      if (!rec) throw new LogError('E_REVISION', `record ${flags.seq} does not exist`);
      io.print(recToJson(rec));
      break;
    }
    case 'verify': {
      if (!flags.cert) throw new LogError('E_USAGE', '--cert is required');
      const raw = fs.existsSync(flags.cert) ? fs.readFileSync(flags.cert, 'utf8') : flags.cert;
      const cert = JSON.parse(raw);
      const log = EventLog.open(file);
      io.print({ valid: log.verifyCertificate(cert) });
      break;
    }
    case 'rebuild': {
      const log = EventLog.open(file);
      io.print({ rebuilt: true, ...log.rebuildIndex() });
      break;
    }
    default:
      throw new LogError('E_USAGE', `unknown command: ${cmd}\n${USAGE}`);
  }
}

// Programmable entry: returns the exit code, routes output through io.
function run(argv, io = {}) {
  const out = io.out ? io.out.bind(io) : (s) => process.stdout.write(s);
  const err = io.err ? io.err.bind(io) : (s) => process.stderr.write(s);
  const print = io.print ? io.print.bind(io) : (v) => out(JSON.stringify(v, null, 2) + '\n');
  try {
    main(argv, { out, err, print });
    return 0;
  } catch (error) {
    const code = error instanceof LogError && EXIT_CODES[error.code] ? EXIT_CODES[error.code] : 1;
    err(`error[${error.code ?? 'E_UNKNOWN'}]: ${error.message}\n`);
    return code;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, EXIT_CODES };
