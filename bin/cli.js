#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { normalizeBranch, validateBranch } from '../src/event.js';
import { mergeBranches } from '../src/merge.js';
import { MergeSession } from '../src/session.js';
import { Store } from '../src/store.js';
import { checkCertificate, checkMergeReport } from '../src/checker.js';

const args = process.argv.slice(2);
const storeDir = args[args.indexOf('--store') + 1] || '.emstore';
const inputFile = args.includes('--input') ? args[args.indexOf('--input') + 1] : null;
const store = new Store(storeDir);
const branches = new Map();
const sessions = new Map();
let sessionSeq = 0;

function sessionState(id, s) {
  return {
    ok: true,
    session: id,
    conflicts: s.result.conflicts.map((c) => ({
      ...c,
      resolved: s.resolutions.get(c.conflictId)?.status === 'ACTIVE',
    })),
    resolutions: [...s.resolutions.values()],
    cycle: s.result.cycle,
    blocked: s.result.blocked,
    missingRefs: s.result.missingRefs,
    certificate: s.result.certificate,
  };
}

function loadEvents(msg) {
  const events = normalizeBranch(msg.events);
  const v = validateBranch(events);
  if (!v.ok) {
    const e = new Error('branch validation failed');
    e.code = 'INVALID_BRANCH';
    e.errors = v.errors;
    throw e;
  }
  return events;
}

function handle(msg) {
  switch (msg.cmd) {
    case 'validate': {
      const events = normalizeBranch(msg.events);
      const v = validateBranch(events);
      return { ok: true, valid: v.ok, errors: v.errors };
    }
    case 'load': {
      const events = loadEvents(msg);
      const version = store.putSnapshot({ events, parents: msg.parents ?? [], meta: { kind: 'branch', name: msg.name } });
      branches.set(msg.name, { events, version });
      return { ok: true, name: msg.name, version };
    }
    case 'merge': {
      const get = (ref) => branches.get(ref) ?? { events: store.getSnapshot(ref).events, version: ref };
      const base = get(msg.base);
      const local = get(msg.local);
      const remote = get(msg.remote);
      const s = new MergeSession({
        base: base.events,
        local: local.events,
        remote: remote.events,
        versions: { base: base.version, local: local.version, remote: remote.version },
      });
      const id = 's' + ++sessionSeq;
      sessions.set(id, s);
      return sessionState(id, s);
    }
    case 'resolve': {
      const s = sessions.get(msg.session);
      if (!s) return { ok: false, code: 'NO_SESSION', error: `unknown session ${msg.session}` };
      const r = s.resolve(msg);
      return { ok: true, ...r, state: sessionState(msg.session, s) };
    }
    case 'updateBranch': {
      const s = sessions.get(msg.session);
      if (!s) return { ok: false, code: 'NO_SESSION', error: `unknown session ${msg.session}` };
      const events = loadEvents(msg);
      const version = store.putSnapshot({ events, parents: [], meta: { kind: 'branch', name: msg.side } });
      const r = s.updateBranch(msg.side, events, version);
      return { ok: true, ...r, state: sessionState(msg.session, s) };
    }
    case 'commit': {
      const s = sessions.get(msg.session);
      if (!s) return { ok: false, code: 'NO_SESSION', error: `unknown session ${msg.session}` };
      const version = s.commit(store);
      return { ok: true, version };
    }
    case 'diff': {
      const diff = store.diff(msg.from, msg.to);
      return { ok: true, diff, inverse: store.invert(diff) };
    }
    case 'applyInverse': {
      const version = store.applyInverse(msg.version, msg.diff);
      return { ok: true, version };
    }
    case 'projection': {
      let events, certificate;
      if (msg.session) {
        const s = sessions.get(msg.session);
        if (!s) return { ok: false, code: 'NO_SESSION', error: `unknown session ${msg.session}` };
        events = s.result.events;
        certificate = s.result.certificate;
      } else {
        const snap = store.getSnapshot(msg.version);
        events = snap.events;
        certificate = snap.meta.certificate ?? null;
      }
      if (!certificate) return { ok: false, code: 'NO_CERTIFICATE', error: 'no topo certificate (cycle or missing refs)' };
      const order = certificate.order.filter((id) => !events.get(id).deleted);
      return { ok: true, order, events: order.map((id) => events.get(id)) };
    }
    case 'check': {
      const snap = store.getSnapshot(msg.version);
      const cert = snap.meta.certificate
        ? checkCertificate(snap.events, snap.meta.certificate)
        : { ok: true, errors: [] };
      let merge = { ok: true, errors: [] };
      if (snap.meta.kind === 'merge' && snap.meta.base && snap.meta.local && snap.meta.remote) {
        merge = checkMergeReport(
          store.getSnapshot(snap.meta.base).events,
          store.getSnapshot(snap.meta.local).events,
          store.getSnapshot(snap.meta.remote).events,
          {
            events: snap.events,
            conflicts: snap.meta.conflicts,
            blocked: snap.meta.blocked,
            cycle: snap.meta.cycle,
            certificate: snap.meta.certificate,
          },
        );
      }
      return { ok: cert.ok && merge.ok, certificate: cert, merge };
    }
    case 'head':
      return { ok: true, head: store.head() };
    default:
      return { ok: false, code: 'BAD_CMD', error: `unknown cmd ${msg.cmd}` };
  }
}

function handleLine(line) {
  if (!line.trim()) return;
  let out;
  try {
    out = handle(JSON.parse(line));
  } catch (e) {
    out = { ok: false, code: e.code ?? 'ERROR', error: e.message, ...(e.errors ? { errors: e.errors } : {}), ...(e.conflicts ? { conflicts: e.conflicts } : {}) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (inputFile) {
  for (const line of readFileSync(inputFile, 'utf8').split('\n')) handleLine(line);
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', handleLine);
}
