import { createHash } from 'node:crypto';
import { eventTs, applyEvent } from './state.js';

// Interval (time-bucket) summary of the journal: bucket -> {count, digest}.
// Peers exchange summaries; buckets that differ identify where events are missing.
export function summarize(state, bucketMs = 60000) {
  const buckets = new Map();
  for (const event of Object.values(state.journal)) {
    const ts = eventTs(event) ?? 0;
    const bucket = Math.floor(ts / bucketMs);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(event.id);
  }
  const out = {};
  for (const [bucket, ids] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    ids.sort();
    const digest = createHash('sha256').update(ids.join('')).digest('hex').slice(0, 16);
    out[bucket] = { count: ids.length, digest };
  }
  return { bucketMs, buckets: out };
}

export function diffSummaries(a, b) {
  const keys = new Set([...Object.keys(a.buckets), ...Object.keys(b.buckets)]);
  const differing = [];
  for (const k of keys) {
    const x = a.buckets[k];
    const y = b.buckets[k];
    if (!x || !y || x.digest !== y.digest) differing.push(Number(k));
  }
  return differing.sort((x, y) => x - y);
}

// Pull events that `target` is missing from `peer`, restricted to buckets whose
// summaries differ. Returns the ids that were applied.
export function repair(target, peer, opts = {}) {
  const bucketMs = opts.bucketMs ?? 60000;
  const differing = diffSummaries(summarize(target, bucketMs), summarize(peer, bucketMs));
  const inDiffering = (event) => differing.includes(Math.floor((eventTs(event) ?? 0) / bucketMs));
  const applied = [];
  for (const event of Object.values(peer.journal)) {
    if (!target.journal[event.id] && inDiffering(event)) {
      applyEvent(target, event, opts);
      applied.push(event.id);
    }
  }
  return applied.sort();
}
