import fs from 'node:fs';
import { Store, StoreIntegrityError, auditValidPrefix } from './store.js';
import { makeEvent, canonical, keyOf } from './events.js';
import { validateLocal, WO_OPS, ALARM_OPS } from './machine.js';

// Exit codes: 2 = usage/invalid input, 3 = domain rejection, 9 = internal/integrity.
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REJECTED: 3, INTERNAL: 9 });

// Thrown by process.exit; lets in-process callers (tests) intercept exits.
export class ExitSentinel extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const BOOL_FLAGS = new Set(['interlock', 'verify']);

function fail(code, errCode, message, extra = {}) {
  process.stderr.write(JSON.stringify({ error: { code: errCode, message, ...extra } }) + '\n');
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) {
        flags[k] = true;
        continue;
      }
      if (i + 1 >= argv.length) fail(EXIT.USAGE, 'USAGE', `missing value for --${k}`);
      flags[k] = argv[i + 1];
      i += 1;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function cmdEmit(argv) {
  const { flags, pos } = parse(argv);
  const op = pos[0];
  const { dir, site, actor } = flags;
  if (!dir || !site || !actor || !op) {
    fail(EXIT.USAGE, 'USAGE', 'emit requires --dir --site --actor and an op');
  }
  const isAlarm = ALARM_OPS.includes(op);
  const isWo = WO_OPS.includes(op);
  if (!isAlarm && !isWo) fail(EXIT.USAGE, 'USAGE', `unknown op: ${op}`);
  const wo = flags.wo ?? null;
  const alarm = flags.alarm ?? null;
  const team = flags.team ?? null;
  if (isWo && !wo) fail(EXIT.USAGE, 'USAGE', `op ${op} requires --wo`);
  if (op === 'assign' && !team) fail(EXIT.USAGE, 'USAGE', 'assign requires --team');
  if (isAlarm && (!alarm || !wo)) fail(EXIT.USAGE, 'USAGE', `op ${op} requires --alarm and --wo`);
  const store = Store.open(dir);
  const kind = isAlarm ? 'alarm' : 'wo';
  const chk = validateLocal(store.state, { kind, op, wo, alarm });
  if (!chk.ok) {
    fail(EXIT.REJECTED, 'REJECTED', `illegal ${op}: ${chk.reason}`, { reason: chk.reason, detail: chk.detail });
  }
  const seq = (store.state.vc[site] || 0) + 1;
  const vc = { ...store.state.vc, [site]: seq };
  const event = makeEvent({
    site, seq, vc, kind, op, wo, alarm, actor, team,
    interlock: Boolean(flags.interlock),
    ts: new Date().toISOString(),
  });
  store.appendEvents([event]);
  const { decisions } = store.commit();
  const d = decisions.find((x) => x.event.id === event.id);
  out({ ok: true, event, decision: d ? d.decision : 'applied', reason: d ? d.reason : 'ok' });
}

function readEventFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail(EXIT.USAGE, 'USAGE', `cannot read event file: ${file}`);
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  return lines.map((l, i) => {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      fail(EXIT.USAGE, 'USAGE', `invalid JSON in event file at line ${i + 1}`);
    }
    if (!e || typeof e !== 'object' || !e.id || !e.site || typeof e.seq !== 'number'
      || !e.vc || !e.op || !e.kind) {
      fail(EXIT.USAGE, 'USAGE', `malformed event at line ${i + 1}`);
    }
    return e;
  });
}

function cmdApply(argv) {
  const { flags } = parse(argv);
  if (!flags.dir || !flags.file) fail(EXIT.USAGE, 'USAGE', 'apply requires --dir and --file');
  const events = readEventFile(flags.file);
  const store = Store.open(flags.dir);
  const added = store.appendEvents(events);
  const { decisions } = store.commit();
  out({
    ok: true,
    received: events.length,
    appended: added.length,
    duplicates: events.length - added.length,
    applied: Object.keys(store.state.applied).length,
    pending: store.state.pending.length,
    decisions: decisions.map((d) => ({
      event: d.event.id, op: d.event.op, decision: d.decision, reason: d.reason,
    })),
  });
}

function cmdSync(argv) {
  const { flags } = parse(argv);
  if (!flags.a || !flags.b) fail(EXIT.USAGE, 'USAGE', 'sync requires --a and --b');
  const sa = Store.open(flags.a);
  const sb = Store.open(flags.b);
  const keysA = new Set(sa.log.map(keyOf));
  const keysB = new Set(sb.log.map(keyOf));
  const toB = sa.log.filter((e) => !keysB.has(keyOf(e)));
  const toA = sb.log.filter((e) => !keysA.has(keyOf(e)));
  sb.appendEvents(toB);
  sb.commit();
  sa.appendEvents(toA);
  sa.commit();
  const converged = canonical(sa.state) === canonical(sb.state);
  out({
    ok: true,
    aToB: toB.length,
    bToA: toA.length,
    converged,
    pending: { a: sa.state.pending.length, b: sb.state.pending.length },
  });
}

function cmdResume(argv) {
  const { flags } = parse(argv);
  if (!flags.dir) fail(EXIT.USAGE, 'USAGE', 'resume requires --dir');
  const store = new Store(flags.dir);
  const report = store.recover();
  out({ ok: true, ...report });
}

function cmdAudit(argv) {
  const { flags } = parse(argv);
  if (!flags.dir) fail(EXIT.USAGE, 'USAGE', 'audit requires --dir');
  const store = new Store(flags.dir);
  const manifest = fs.existsSync(store.p.manifest)
    ? JSON.parse(fs.readFileSync(store.p.manifest, 'utf8'))
    : null;
  const raw = fs.existsSync(store.p.audit) ? fs.readFileSync(store.p.audit, 'utf8') : '';
  const entries = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  const { validCount, head } = auditValidPrefix(entries);
  const committed = manifest ? manifest.count : 0;
  const verified = validCount === entries.length
    && entries.length === committed
    && (manifest === null ? entries.length === 0 : head === manifest.head);
  if (flags.verify && !verified) {
    fail(EXIT.INTERNAL, 'INTEGRITY', 'audit verification failed', {
      entries: entries.length, valid: validCount, committed,
    });
  }
  out({
    ok: true,
    verified,
    count: committed,
    head: manifest ? manifest.head : null,
    entries: entries.length,
    audit: entries,
  });
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'emit': return cmdEmit(rest);
      case 'apply': return cmdApply(rest);
      case 'sync': return cmdSync(rest);
      case 'resume': return cmdResume(rest);
      case 'audit': return cmdAudit(rest);
      default:
        fail(EXIT.USAGE, 'USAGE', `unknown command: ${cmd ?? '(none)'}`,
          { commands: ['emit', 'apply', 'sync', 'resume', 'audit'] });
    }
  } catch (e) {
    if (e instanceof ExitSentinel) throw e;
    if (e instanceof StoreIntegrityError) fail(EXIT.INTERNAL, 'INTEGRITY', e.message);
    fail(EXIT.INTERNAL, 'INTERNAL', e.message);
  }
  return undefined;
}
