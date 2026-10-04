import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hashValue } from './canonical.js';

export function mapToObj(events) {
  const obj = {};
  for (const id of [...events.keys()].sort()) obj[id] = events.get(id);
  return obj;
}

export function eventsHashOf(events) {
  return hashValue(mapToObj(events));
}

function atomicWrite(file, contents) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Content-addressed immutable snapshot store.
export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
  }

  putSnapshot({ events, parents = [], meta = {} }) {
    const body = { events: mapToObj(events), parents, meta };
    const version = hashValue(body);
    const file = join(this.dir, 'snapshots', version + '.json');
    if (!existsSync(file)) atomicWrite(file, JSON.stringify({ version, ...body }, null, 2));
    return version;
  }

  has(version) {
    return existsSync(join(this.dir, 'snapshots', version + '.json'));
  }

  getSnapshot(version) {
    const file = join(this.dir, 'snapshots', version + '.json');
    if (!existsSync(file)) throw err('NO_SUCH_SNAPSHOT', `unknown snapshot ${version}`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version,
      events: new Map(Object.entries(raw.events)),
      parents: raw.parents,
      meta: raw.meta,
      eventsHash: hashValue(raw.events),
    };
  }

  commitMerge({ events, parents, meta }) {
    const version = this.putSnapshot({ events, parents, meta });
    atomicWrite(join(this.dir, 'HEAD'), version);
    return version;
  }

  head() {
    const f = join(this.dir, 'HEAD');
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
  }

  // Forward diff old -> new. Ops carry before/after so the diff is invertible.
  diff(fromV, toV) {
    const a = this.getSnapshot(fromV);
    const b = this.getSnapshot(toV);
    const ops = [];
    const ids = [...new Set([...a.events.keys(), ...b.events.keys()])].sort();
    for (const id of ids) {
      const ea = a.events.get(id);
      const eb = b.events.get(id);
      if (ea && !eb) ops.push({ op: 'remove', id, before: ea });
      else if (!ea && eb) ops.push({ op: 'add', id, after: eb });
      else if (canonical(ea) !== canonical(eb)) ops.push({ op: 'set', id, before: ea, after: eb });
    }
    return {
      kind: 'snapshot-diff',
      from: fromV,
      to: toV,
      fromEventsHash: a.eventsHash,
      toEventsHash: b.eventsHash,
      ops,
    };
  }

  invert(d) {
    const ops = [...d.ops].reverse().map((op) => {
      if (op.op === 'add') return { op: 'remove', id: op.id, before: op.after };
      if (op.op === 'remove') return { op: 'add', id: op.id, after: op.before };
      return { op: 'set', id: op.id, before: op.after, after: op.before };
    });
    return {
      kind: 'snapshot-diff',
      from: d.to,
      to: d.from,
      fromEventsHash: d.toEventsHash,
      toEventsHash: d.fromEventsHash,
      ops,
    };
  }

  // Applies a diff (forward or inverse). The post-image events hash is
  // verified before anything is written; on mismatch the store, history and
  // index are left untouched.
  applyDiff(version, d) {
    const snap = this.getSnapshot(version);
    if (snap.eventsHash !== d.fromEventsHash) {
      throw err('PREIMAGE_HASH_MISMATCH', 'diff does not apply to this snapshot');
    }
    const events = new Map([...snap.events].map(([id, e]) => [id, { ...e, dependsOn: [...e.dependsOn] }]));
    for (const op of d.ops) {
      if (op.op === 'add' || op.op === 'set') events.set(op.id, op.after);
      else if (op.op === 'remove') events.delete(op.id);
    }
    const post = eventsHashOf(events);
    if (post !== d.toEventsHash) {
      throw err('POSTIMAGE_HASH_MISMATCH', 'post-image hash mismatch; nothing was written');
    }
    return this.putSnapshot({
      events,
      parents: [version],
      meta: { kind: 'apply-diff', from: d.from, to: d.to },
    });
  }

  applyInverse(version, inverseDiff) {
    return this.applyDiff(version, inverseDiff);
  }
}
