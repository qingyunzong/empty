import { validateEvent, canonicalJSON } from './event.js';
import { ConflictError } from './errors.js';
import { replay } from './replay.js';
import { computeDigest } from './digest.js';

// A single-process stand-in for one offline collector. Events may arrive in any
// order; state is always a deterministic function of the stored set.
export class Replica {
  constructor(name) {
    this.name = name;
    this.events = new Map();
  }

  addEvent(event) {
    const e = validateEvent(event);
    const prev = this.events.get(e.id);
    if (prev) {
      if (canonicalJSON(prev) !== canonicalJSON(e)) throw new ConflictError(e.id);
      return false;
    }
    this.events.set(e.id, e);
    return true;
  }

  addEvents(events) {
    let added = 0;
    for (const e of events) if (this.addEvent(e)) added += 1;
    return added;
  }

  has(id) {
    return this.events.has(id);
  }

  get size() {
    return this.events.size;
  }

  digest() {
    return computeDigest(this.events.values());
  }

  state() {
    return replay(this.events.values());
  }

  // Anti-entropy: ids the remote digest advertises that this replica lacks.
  missingFrom(remoteDigest) {
    return remoteDigest.ids.filter((id) => !this.events.has(id));
  }

  // Anti-entropy: exactly the events the remote lacks - nothing more is pulled.
  offerTo(remoteDigest) {
    const remoteIds = new Set(remoteDigest.ids);
    return [...this.events.values()].filter((e) => !remoteIds.has(e.id));
  }
}

// One anti-entropy round between two replicas: exchange digests, pull ONLY the
// missing events in each direction, then prove convergence by comparing digests.
export function syncReplicas(a, b) {
  const digestA = a.digest();
  const digestB = b.digest();
  const toB = a.offerTo(digestB);
  const toA = b.offerTo(digestA);
  a.addEvents(toA);
  b.addEvents(toB);
  const afterA = a.digest();
  const afterB = b.digest();
  const converged = afterA.hash === afterB.hash;
  return {
    transferred: { toA: toA.map((e) => e.id), toB: toB.map((e) => e.id) },
    converged,
    certificate: converged
      ? { converged: true, hash: afterA.hash, count: afterA.count, clock: afterA.clock }
      : { converged: false, hashA: afterA.hash, hashB: afterB.hash },
  };
}
