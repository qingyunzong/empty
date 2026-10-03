import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { syncStores } from './sync.js';
import { buildCert, verifyCert } from './cert.js';
import { LotError, EXIT } from './errors.js';

function parseLotMass(spec) {
  const i = spec.lastIndexOf(':');
  if (i <= 0) throw new LotError(EXIT.VALIDATION, `bad lot:mass spec ${spec}`);
  const mass = Number(spec.slice(i + 1));
  if (!Number.isFinite(mass) || mass <= 0) throw new LotError(EXIT.VALIDATION, `bad mass in ${spec}`);
  return { lot: spec.slice(0, i), mass };
}

// io is injectable so the CLI can be tested in-process.
function makeIo(io) {
  return {
    stdout: io?.stdout ?? ((s) => process.stdout.write(s)),
    stderr: io?.stderr ?? ((s) => process.stderr.write(s)),
    exitCode: 0,
    setExit(code) {
      this.exitCode = code;
      if (io) io.exitCode = code;
      else process.exitCode = code;
    },
  };
}

function buildCmds(io) {
const out = (obj) => io.stdout(JSON.stringify(obj) + '\n');
const CMDS = {
  add: {
    options: {
      store: { type: 'string' }, op: { type: 'string' }, register: { type: 'string' },
      in: { type: 'string', multiple: true }, out: { type: 'string', multiple: true },
      ts: { type: 'string' }, site: { type: 'string' }, tolerance: { type: 'string' },
    },
    run(v) {
      const store = Store.init(v.store, { site: v.site, tolerance: v.tolerance ? Number(v.tolerance) : undefined });
      const req = v.register
        ? { op: 'register', out: [parseLotMass(v.register)] }
        : { op: v.op, in: (v.in || []).map(parseLotMass), out: (v.out || []).map(parseLotMass) };
      if (v.ts !== undefined) req.ts = Number(v.ts);
      if (v.site) req.site = v.site;
      const { entry, verdict } = store.add(req);
      out({ ok: true, verdict, id: entry.id, seq: entry.seq, pending: store.graph.pending.length });
      if (verdict === 'pending') {
        io.stderr(JSON.stringify({ ok: false, error: 'unknown parent lot: operation pending', code: EXIT.PENDING, id: entry.id }) + '\n');
        io.setExit(EXIT.PENDING);
      }
    },
  },
  sync: {
    options: { store: { type: 'string' }, peer: { type: 'string' } },
    run(v) {
      const a = Store.init(v.store);
      const b = Store.init(v.peer);
      const result = syncStores(a, b);
      out({ ok: true, ...result });
      if (result.pendingA > 0) {
        io.stderr(JSON.stringify({ ok: false, error: `${result.pendingA} operation(s) pending unknown parents`, code: EXIT.PENDING }) + '\n');
        io.setExit(EXIT.PENDING);
      }
    },
  },
  resume: {
    options: { store: { type: 'string' } },
    run(v) {
      const store = Store.init(v.store);
      const report = store.resume();
      out({ ok: true, ...report });
    },
  },
  prove: {
    options: { store: { type: 'string' }, lot: { type: 'string' }, out: { type: 'string' } },
    run(v) {
      const store = Store.init(v.store);
      const cert = buildCert(store.graph, v.lot);
      const commit = store.commitCert(cert);
      if (v.out) fs.writeFileSync(v.out, JSON.stringify(cert, null, 2) + '\n');
      out({ ok: true, root: cert.root, head: cert.head, entries: cert.count, committed: commit.committed, path: commit.path });
    },
  },
  verify: {
    options: { store: { type: 'string' }, cert: { type: 'string' } },
    run(v) {
      const cert = JSON.parse(fs.readFileSync(v.cert, 'utf8'));
      const result = verifyCert(cert);
      if (v.store) {
        const store = Store.init(v.store);
        if (!store.manifestEntries().some((m) => m.head === cert.head))
          throw new LotError(EXIT.CERT, `certificate head ${cert.head} not committed in store manifest`);
      }
      out({ ok: true, ...result });
    },
  },
};

  return CMDS;
}

export function main(argv, ioImpl) {
  const io = makeIo(ioImpl);
  const CMDS = buildCmds(io);
  const [cmd, ...rest] = argv;
  const spec = CMDS[cmd];
  if (!spec) {
    io.stderr(JSON.stringify({ ok: false, error: `unknown command ${cmd ?? ''}; use add|sync|resume|prove|verify`, code: 1 }) + '\n');
    io.setExit(1);
    return io.exitCode;
  }
  try {
    const { values } = parseArgs({ args: rest, options: spec.options, strict: true });
    if (!values.store) throw new LotError(1, '--store is required');
    spec.run(values);
  } catch (err) {
    const code = err instanceof LotError ? err.code : 1;
    const payload = { ok: false, error: err.message, code };
    if (err.details !== undefined) payload.details = err.details;
    io.stderr(JSON.stringify(payload) + '\n');
    io.setExit(code);
  }
  return io.exitCode;
}
