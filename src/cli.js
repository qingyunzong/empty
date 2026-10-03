#!/usr/bin/env node
import { AlertStore, AlertError } from './store.js';

const EXIT_CODES = { E_USAGE: 2, E_GAP: 3, E_CRC: 4, E_CURSOR: 5 };

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    }
  }
  return flags;
}

function serializeAlert(a) {
  return {
    device: a.device,
    seq: a.seq.toString(),
    severity: a.severity,
    ts: a.ts.toString(),
    message: a.message,
  };
}

const USAGE = [
  'usage:',
  '  alert-store append --dir D --device ID --seq N [--severity S] [--message M] [--ts MS]',
  '  alert-store replay --dir D [--cursor TOKEN]',
  '  alert-store verify --dir D --cursor TOKEN',
  '  alert-store stats  --dir D',
].join('\n');

// Returns the process exit code. io defaults to stdout/stderr but is
// injectable so the CLI can be driven in-process from tests.
export function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  try {
    const [cmd, ...rest] = argv;
    const flags = parseFlags(rest);
    if (!cmd || !flags.dir) throw new AlertError('E_USAGE', USAGE);
    const store = new AlertStore(flags.dir, {
      segmentSize: flags['segment-size'] ? Number(flags['segment-size']) : undefined,
      maxSegments: flags['max-segments'] ? Number(flags['max-segments']) : undefined,
    });
    try {
      switch (cmd) {
        case 'append': {
          if (!flags.device || flags.seq === undefined) throw new AlertError('E_USAGE', USAGE);
          const result = store.append({
            device: flags.device,
            seq: flags.seq,
            severity: Number(flags.severity ?? 0),
            message: flags.message ?? '',
            ts: flags.ts !== undefined ? Number(flags.ts) : Date.now(),
          });
          io.out(JSON.stringify({ ok: true, ...result, seq: result.seq?.toString() }));
          return 0;
        }
        case 'replay': {
          const { alerts, cursor } = store.replay(flags.cursor);
          io.out(JSON.stringify({ ok: true, alerts: alerts.map(serializeAlert), cursor }));
          return 0;
        }
        case 'verify': {
          if (!flags.cursor) throw new AlertError('E_USAGE', USAGE);
          const valid = store.verifyCursor(flags.cursor);
          io.out(JSON.stringify({ ok: true, valid }));
          return valid ? 0 : 1;
        }
        case 'stats':
          io.out(JSON.stringify({ ok: true, ...store.stats() }));
          return 0;
        default:
          throw new AlertError('E_USAGE', `unknown command: ${cmd}\n${USAGE}`);
      }
    } finally {
      store.close();
    }
  } catch (err) {
    if (err instanceof AlertError) {
      const out = { ok: false, code: err.code, message: err.message };
      if (err.expected !== undefined) out.expected = err.expected.toString();
      if (err.got !== undefined) out.got = err.got.toString();
      io.err(JSON.stringify(out));
      return EXIT_CODES[err.code] ?? 1;
    }
    io.err(JSON.stringify({ ok: false, code: 'E_INTERNAL', message: String(err?.message ?? err) }));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  process.exitCode = run(process.argv.slice(2));
}
