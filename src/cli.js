import fs from 'node:fs';
import { Store } from './store.js';

function fail(code, error, message, details = {}) {
  process.stderr.write(JSON.stringify({ code, error, message, ...details }) + '\n');
  process.exit(code);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) opts[k] = true;
      else { opts[k] = nxt; i++; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function makeFaultHook() {
  const point = process.env.EVENT_TRACE_FAULT;
  if (!point) return null;
  const tx = process.env.EVENT_TRACE_FAULT_TX;
  let fired = false;
  return (p, id) => {
    if (!fired && p === point && (tx === undefined || tx === id)) {
      fired = true;
      process.stderr.write(JSON.stringify({ code: 4, error: 'FAULT_INJECTED', point: p, tx: id }) + '\n');
      process.exit(99);
    }
  };
}

function openStore(dir, opts) {
  return new Store(dir, {
    windowMs: opts['window-ms'] !== undefined ? Number(opts['window-ms']) : 300000,
    faultHook: makeFaultHook() ?? undefined,
  }).open();
}

function cmdIngest(dir, opts) {
  let text;
  if (opts.file) {
    if (!fs.existsSync(opts.file)) fail(3, 'NOT_FOUND', `input file not found: ${opts.file}`);
    text = fs.readFileSync(opts.file, 'utf8');
  } else {
    text = fs.readFileSync(0, 'utf8');
  }
  const events = [];
  const malformedLines = [];
  text.split('\n').forEach((line, idx) => {
    if (line.trim().length === 0) return;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      malformedLines.push({ line: idx + 1, error: `invalid JSON: ${err.message}` });
    }
  });
  const store = openStore(dir, opts);
  const report = store.ingest(events);
  report.malformed.push(...malformedLines);
  print(report);
  if (report.rejected.length > 0 || report.malformed.length > 0) {
    fail(2, 'VALIDATION', `${report.rejected.length} rejected, ${report.malformed.length} malformed`, {
      rejected: report.rejected,
      malformed: report.malformed,
    });
  }
}

function cmdSync(dir, opts) {
  if (!opts.remote) fail(3, 'USAGE', 'sync requires --remote <dir>');
  if (!fs.existsSync(opts.remote)) fail(3, 'NOT_FOUND', `remote dir not found: ${opts.remote}`);
  const local = openStore(dir, opts);
  const remote = openStore(opts.remote, opts);
  const toLocal = remote.loggedEvents().filter((e) => !local.eventsById.has(e.id));
  const toRemote = local.loggedEvents().filter((e) => !remote.eventsById.has(e.id));
  const pulled = local.ingest(toLocal);
  const pushed = remote.ingest(toRemote);
  print({
    pulled: toLocal.length,
    pushed: toRemote.length,
    localPending: local.engine.pendingList.map((p) => p.event.id),
    remotePending: remote.engine.pendingList.map((p) => p.event.id),
    localRejected: pulled.rejected,
    remoteRejected: pushed.rejected,
  });
  if (pulled.rejected.length > 0 || pushed.rejected.length > 0) {
    fail(2, 'VALIDATION', 'rejected events during sync', { localRejected: pulled.rejected, remoteRejected: pushed.rejected });
  }
}

function cmdResume(dir, opts) {
  const store = openStore(dir, opts);
  print({
    recovered: true,
    ...store.lastRecovery,
    applied: store.engine.appliedIds.length,
    pending: store.engine.pendingList.map((p) => p.event.id),
    rejected: store.engine.rejectedList,
    watermark: store.engine.watermark,
  });
}

function cmdAudit(dir, opts) {
  if (!fs.existsSync(dir)) fail(3, 'NOT_FOUND', `data dir not found: ${dir}`);
  const store = openStore(dir, opts);
  for (const rec of store.auditTrail()) {
    if (opts.lot && rec.lot !== opts.lot) continue;
    print(rec);
  }
}

function cmdCert(dir, opts) {
  if (!opts.lot) fail(3, 'USAGE', 'cert requires --lot <lot>');
  const store = openStore(dir, opts);
  const cert = store.engine.cert(opts.lot);
  if (!cert) fail(3, 'NOT_FOUND', `unknown lot: ${opts.lot}`);
  print(cert);
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const dir = opts.dir ?? '.event-trace';
  try {
    switch (cmd) {
      case 'ingest': return cmdIngest(dir, opts);
      case 'sync': return cmdSync(dir, opts);
      case 'resume': return cmdResume(dir, opts);
      case 'audit': return cmdAudit(dir, opts);
      case 'cert': return cmdCert(dir, opts);
      default: return fail(3, 'USAGE', `unknown command: ${cmd ?? '(none)'}; expected ingest|sync|resume|audit|cert`);
    }
  } catch (err) {
    if (err && err.code === 'VALIDATION') fail(2, 'VALIDATION', err.message);
    fail(4, 'INTERNAL', err?.message ?? String(err));
  }
}
