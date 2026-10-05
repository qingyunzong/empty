import { createHash } from 'node:crypto';
import { canonicalOrder, canonicalJSON } from './event.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Content digest of an event set: canonical-order hash + vector clock + per-member
// seqs. Two replicas are converged iff their hashes are equal.
export function computeDigest(events) {
  const byId = new Map();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  const list = [...byId.values()];
  const ordered = canonicalOrder(list);
  const clock = {};
  const seqs = {};
  for (const e of list) {
    clock[e.member] = Math.max(clock[e.member] ?? 0, e.seq);
    (seqs[e.member] ??= new Set()).add(e.seq);
  }
  const sortedSeqs = {};
  for (const [m, s] of Object.entries(seqs)) sortedSeqs[m] = [...s].sort((a, b) => a - b);
  return {
    hash: `sha256:${sha256(ordered.map(canonicalJSON).join('\n'))}`,
    count: list.length,
    clock,
    seqs: sortedSeqs,
    ids: ordered.map((e) => e.id),
  };
}

function toRanges(sortedNums) {
  const ranges = [];
  for (const n of sortedNums) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else ranges.push({ from: n, to: n });
  }
  return ranges;
}

// Divergence report between two digests: per member, the seq ranges only one side
// has. This is the "divergence range" printed on exit code 5.
export function diffDigests(a, b) {
  const divergence = [];
  const members = new Set([...Object.keys(a.seqs), ...Object.keys(b.seqs)]);
  for (const m of [...members].sort()) {
    const sa = new Set(a.seqs[m] ?? []);
    const sb = new Set(b.seqs[m] ?? []);
    const onlyInA = [...sa].filter((s) => !sb.has(s)).sort((x, y) => x - y);
    const onlyInB = [...sb].filter((s) => !sa.has(s)).sort((x, y) => x - y);
    if (onlyInA.length > 0 || onlyInB.length > 0) {
      divergence.push({ member: m, onlyInA: toRanges(onlyInA), onlyInB: toRanges(onlyInB) });
    }
  }
  return { equal: a.hash === b.hash, hashA: a.hash, hashB: b.hash, divergence };
}
