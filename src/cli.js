// event-trace CLI. Exit codes: 0 ok, 2 VALIDATION, 3 STORAGE, 4 CONFLICT.
// All diagnostics go to stderr as JSON lines; results go to stdout as JSON.
import fs from 'node:fs';
import { EXIT, TraceError, validation } from './errors.js';
import { parseJsonl } from './event.js';
import { Store } from './store.js';
import { ingestEvents, recoverAndFinalize, DEFAULT_WINDOW_MS } from './engine.js';
import { syncStores } from './sync.js';
import { auditStore } from './audit.js';
import { buildCertificate } from './cert.js';

const errJson = (obj) => process.stderr.write(JSON.stringify(obj) + '\n');
const outJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function need(args, key) {
  if (args[key] === undefined || args[key] === true) throw validation(`missing required --${key}`);
  return args[key];
}

function cmdIngest(args) {
  const dir = need(args, 'dir');
  const file = need(args, 'file');
  const window = args.window !== undefined ? Number(args.window) : DEFAULT_WINDOW_MS;
  if (!Number.isFinite(window) || window < 0) throw validation('--window must be a non-negative number');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new TraceError('STORAGE', `cannot read ${file}: ${err.message}`);
  }
  const { events, errors } = parseJsonl(text);
  for (const e of errors) errJson({ ok: false, ...e });

  const store = Store.fromEnv(dir);
  const report = ingestEvents(store, events, { window });
  for (const e of report.errors) errJson({ ok: false, ...e });
  outJson({ ok: true, command: 'ingest', ...report, recovery: undefined });

  if (errors.length > 0 || report.errors.length > 0) return EXIT.VALIDATION;
  if (report.pending.length > 0 || report.conflicts.length > 0) return EXIT.CONFLICT;
  return EXIT.OK;
}

function cmdSync(args) {
  const dir = need(args, 'dir');
  const peer = need(args, 'peer');
  const window = args.window !== undefined ? Number(args.window) : DEFAULT_WINDOW_MS;
  const report = syncStores(dir, peer, { window });
  outJson({ ok: true, command: 'sync', ...report });
  if (report.pending.length > 0 || report.conflicts.length > 0) return EXIT.CONFLICT;
  return EXIT.OK;
}

function cmdResume(args) {
  const dir = need(args, 'dir');
  const store = Store.fromEnv(dir);
  const report = recoverAndFinalize(store, {
    window: args.window !== undefined ? Number(args.window) : DEFAULT_WINDOW_MS,
  });
  outJson({ ok: true, command: 'resume', ...report });
  if (report.pending.length > 0) return EXIT.CONFLICT;
  return EXIT.OK;
}

function cmdAudit(args) {
  const dir = need(args, 'dir');
  const report = auditStore(dir);
  outJson({ command: 'audit', ...report });
  if (!report.ok) {
    for (const p of report.problems) errJson({ ok: false, code: 'STORAGE', message: p });
    return EXIT.STORAGE;
  }
  return EXIT.OK;
}

function cmdCert(args) {
  const dir = need(args, 'dir');
  const lot = need(args, 'lot');
  const store = Store.fromEnv(dir);
  recoverAndFinalize(store, {});
  const cert = buildCertificate(store, lot);
  outJson({ ok: true, command: 'cert', ...cert });
  return EXIT.OK;
}

const COMMANDS = { ingest: cmdIngest, sync: cmdSync, resume: cmdResume, audit: cmdAudit, cert: cmdCert };

export function main(argv) {
  const [cmd, ...rest] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    errJson({ ok: false, code: 'VALIDATION', message: `unknown command ${JSON.stringify(cmd)}; expected one of ${Object.keys(COMMANDS).join(', ')}` });
    return EXIT.VALIDATION;
  }
  try {
    return fn(parseArgs(rest));
  } catch (err) {
    if (err instanceof TraceError) {
      errJson(err.toJSON());
      return EXIT[err.code] ?? EXIT.STORAGE;
    }
    errJson({ ok: false, code: 'STORAGE', message: String(err?.message ?? err) });
    return EXIT.STORAGE;
  }
}
