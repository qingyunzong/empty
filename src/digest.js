import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function computeDigest(events) {
  const members = {};
  for (const e of events) {
    const m = (members[e.member] ??= { maxSeq: 0, maxEpoch: 0 });
    if (e.seq > m.maxSeq) m.maxSeq = e.seq;
    if (e.epoch > m.maxEpoch) m.maxEpoch = e.epoch;
  }
  const sorted = Object.fromEntries(Object.entries(members).sort());
  const ids = events.map((e) => e.id).sort();
  return { members: sorted, count: events.length, hash: sha256(ids.join('\n')) };
}

export function digestsEqual(a, b) {
  return (
    a.hash === b.hash &&
    a.count === b.count &&
    JSON.stringify(a.members) === JSON.stringify(b.members)
  );
}

export function divergence(a, b) {
  const members = {};
  const names = new Set([...Object.keys(a.members), ...Object.keys(b.members)]);
  for (const name of [...names].sort()) {
    const x = a.members[name] ?? { maxSeq: 0, maxEpoch: 0 };
    const y = b.members[name] ?? { maxSeq: 0, maxEpoch: 0 };
    if (x.maxSeq !== y.maxSeq || x.maxEpoch !== y.maxEpoch) {
      members[name] = {
        a: x,
        b: y,
        interval: [Math.min(x.maxSeq, y.maxSeq) + 1, Math.max(x.maxSeq, y.maxSeq)],
      };
    }
  }
  return { equal: digestsEqual(a, b), hashA: a.hash, hashB: b.hash, members };
}

export function missingRanges(localEvents, remoteDigest) {
  const have = new Map();
  for (const e of localEvents) {
    if (!have.has(e.member)) have.set(e.member, new Set());
    have.get(e.member).add(e.seq);
  }
  const missing = {};
  for (const [member, info] of Object.entries(remoteDigest.members)) {
    const owned = have.get(member) ?? new Set();
    const ranges = [];
    let start = null;
    for (let seq = 1; seq <= info.maxSeq; seq++) {
      if (!owned.has(seq)) {
        if (start === null) start = seq;
      } else if (start !== null) {
        ranges.push([start, seq - 1]);
        start = null;
      }
    }
    if (start !== null) ranges.push([start, info.maxSeq]);
    if (ranges.length > 0) missing[member] = ranges;
  }
  return missing;
}

export function proveConvergence(...digests) {
  if (digests.length < 2) return { converged: true, digest: digests[0] ?? null };
  const first = digests[0];
  const converged = digests.every((d) => digestsEqual(first, d));
  return { converged, hash: first.hash, count: first.count };
}

export function certificate(events, state) {
  const digest = computeDigest(events);
  const stateHash = sha256(
    JSON.stringify({
      valve: state.valve,
      interlocked: state.interlocked,
      activeBypasses: state.activeBypasses,
      keys: state.keys,
      members: state.members,
      applied: state.applied,
      rejected: state.rejected,
    })
  );
  return {
    digest,
    stateHash,
    orderHash: sha256(state.order.join('\n')),
    eventCount: events.length,
  };
}
