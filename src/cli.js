import fs from 'node:fs';
import { makeLot, makeEvent, LotError, EXIT } from './core.js';
import { Store, syncStores } from './store.js';
import { buildCert, verifyCert } from './cert.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function parseEndpoints(spec) {
  return String(spec).split(',').map((part) => {
    const [lot, mass] = part.split(':');
    return { lot, mass: Number(mass) };
  });
}

function emitOk(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }) + '\n');
}

function emitErr(code, message, details) {
  process.stderr.write(JSON.stringify({ ok: false, code, error: message, ...(details ? { details } : {}) }) + '\n');
  process.exitCode = code;
}

function openStore(args) {
  if (!args.dir) throw new LotError(EXIT.OTHER, '--dir required');
  return Store.open(args.dir, { tol: args.tol !== undefined ? Number(args.tol) : undefined });
}

function reportPending(store) {
  const p = store.pending();
  if (p.events.length > 0) {
    emitErr(EXIT.PENDING, 'pending records remain', p);
    return true;
  }
  return false;
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'add': return cmdAdd(args);
      case 'sync': return cmdSync(args);
      case 'resume': return cmdResume(args);
      case 'prove': return cmdProve(args);
      case 'verify': return cmdVerify(args);
      default:
        emitErr(EXIT.OTHER, `unknown command: ${cmd}`, {
          usage: 'lot-genealogy <add|sync|resume|prove|verify> [--dir D] ...',
        });
    }
  } catch (err) {
    if (err instanceof LotError) emitErr(err.code, err.message, err.details);
    else emitErr(EXIT.OTHER, err.message);
  }
}

function cmdAdd(args) {
  const store = openStore(args);
  try {
    const site = args.site ?? 'hq';
    const ts = args.ts ?? new Date().toISOString();
    if (args.lot) {
      const lot = makeLot({
        id: args.lot,
        mass: Number(args.mass),
        unit: args.unit ?? 'kg',
        site,
        seq: store.nextSeq(site),
        createdAt: ts,
        status: args.status ?? 'open',
      });
      const added = store.appendRecord(lot);
      emitOk({ kind: 'lot', id: lot.id, added, vv: store.vv });
    } else if (args.op) {
      const event = makeEvent({
        op: args.op,
        inputs: parseEndpoints(args.in),
        outputs: parseEndpoints(args.out),
        ts,
        site,
        seq: store.nextSeq(site),
      });
      const added = store.appendRecord(event);
      emitOk({ kind: 'event', id: event.id, added, pending: store.pending(), vv: store.vv });
    } else {
      throw new LotError(EXIT.OTHER, 'add requires --lot or --op');
    }
    if (reportPending(store)) return;
  } finally {
    store.close();
  }
}

function cmdSync(args) {
  if (!args.with) throw new LotError(EXIT.OTHER, '--with required');
  const a = openStore(args);
  let b;
  try {
    b = Store.open(args.with, { tol: a.graph.tol });
    const moved = syncStores(a, b);
    emitOk({ moved, vvA: a.vv, vvB: b.vv, pendingA: a.pending(), pendingB: b.pending() });
    const pending = a.pending().events.length + b.pending().events.length;
    if (pending > 0) emitErr(EXIT.PENDING, 'sync converged with pending records', { pendingA: a.pending(), pendingB: b.pending() });
  } finally {
    a.close();
    b?.close();
  }
}

function cmdResume(args) {
  const store = openStore(args); // open() already ran recovery
  try {
    store.graph.tryResolvePending();
    store.saveSnapshot();
    emitOk({ recovered: true, lots: store.graph.lots.size, events: store.graph.events.size, pending: store.pending(), vv: store.vv });
    reportPending(store);
  } finally {
    store.close();
  }
}

function cmdProve(args) {
  if (!args.lot) throw new LotError(EXIT.OTHER, '--lot required');
  const store = openStore(args);
  try {
    const cert = buildCert(store.graph, args.lot);
    const committed = store.commitCert(cert);
    const json = JSON.stringify(cert, null, 2);
    if (args.out) fs.writeFileSync(args.out, json + '\n');
    else process.stdout.write(json + '\n');
    process.stderr.write(JSON.stringify({ ok: true, certId: cert.certId, committed }) + '\n');
  } finally {
    store.close();
  }
}

function cmdVerify(args) {
  if (!args.cert) throw new LotError(EXIT.OTHER, '--cert required');
  const cert = JSON.parse(args.cert === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.cert, 'utf8'));
  let graph;
  let store;
  if (args.dir) {
    store = openStore(args);
    graph = store.graph;
  }
  try {
    const result = verifyCert(cert, { graph });
    emitOk(result);
  } finally {
    store?.close();
  }
}
