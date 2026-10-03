import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AuditService } from './service.js';
import { AuditError } from './errors.js';

const USAGE = `usage: audit-intervals <command> [args]
  import <file|->        batch import ops: [{"op":"add","kind":"VALID","intervals":[[s,e]...]}]
  query <point>          classify a point (VALID/FROZEN/EXEMPT/PENDING/UNCOVERED)
  report <lo> <hi>       gap / overlap / pending report over [lo, hi)
  patch <file|->         apply reverse patch: {"kind":"VALID","reason":"...","remove":[],"add":[]}
  revert <patchId>       revert an applied patch
  certs                  list certificates
  verify                 verify the whole certificate chain
  state [kind]           show current interval state
state file: set AUDIT_STATE_FILE (default ./audit-state.json)`;

function toIntervals(raw) {
  return raw.map((iv) => (Array.isArray(iv) ? { start: iv[0], end: iv[1] } : iv));
}

function normalizeOps(payload) {
  const ops = Array.isArray(payload) ? payload : payload.ops;
  return ops.map((op) => ({ ...op, intervals: toIntervals(op.intervals ?? []) }));
}

// io: { stateFile, readStdin(), out(text), err(text) }
export function runCli(argv, io) {
  const [cmd, ...args] = argv;
  const load = () => (existsSync(io.stateFile)
    ? AuditService.fromJSON(JSON.parse(readFileSync(io.stateFile, 'utf8')))
    : new AuditService());
  const save = (svc) => writeFileSync(io.stateFile, JSON.stringify(svc.toJSON(), null, 2) + '\n');
  const readJson = (arg) => JSON.parse(arg === '-' ? io.readStdin() : readFileSync(arg, 'utf8'));
  const print = (value) => io.out(JSON.stringify(value, null, 2) + '\n');

  try {
    const svc = load();
    switch (cmd) {
      case 'import': {
        const cert = svc.importBatch(normalizeOps(readJson(args[0])));
        save(svc);
        print(cert);
        return 0;
      }
      case 'query':
        print(svc.queryPoint(Number(args[0])));
        return 0;
      case 'report':
        print(svc.report(Number(args[0]), Number(args[1])));
        return 0;
      case 'patch': {
        const p = readJson(args[0]);
        const cert = svc.applyPatch({
          patchId: p.patchId,
          targetCertId: p.targetCertId,
          reason: p.reason,
          kind: p.kind,
          remove: toIntervals(p.remove ?? []),
          add: toIntervals(p.add ?? []),
        });
        save(svc);
        print(cert);
        return 0;
      }
      case 'revert': {
        const cert = svc.revertPatch(args[0]);
        save(svc);
        print(cert);
        return 0;
      }
      case 'certs':
        print(svc.exportCerts());
        return 0;
      case 'verify':
        print(svc.verify());
        return 0;
      case 'state':
        print(svc.getState(args[0]));
        return 0;
      default:
        io.err(USAGE + '\n');
        return cmd === undefined ? 0 : 2;
    }
  } catch (err) {
    if (err instanceof AuditError) {
      io.err(JSON.stringify({ error: err.code, message: err.message }) + '\n');
      return 1;
    }
    throw err;
  }
}
