import { GateState } from './state.js';

function nextTs(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts + '+1m' : new Date(t + 60_000).toISOString();
}

// BFS for the minimal appended event sequence that flips `orderId`
// from releasable to not releasable.
export function findCounterexample(config, baseEvents, orderId, maxDepth = 3) {
  const base = GateState.replay(config, baseEvents);
  if (!base.isReleasable(orderId)) {
    return { found: false, reason: 'order-not-releasable-in-base-state' };
  }
  const lastTs = baseEvents.length > 0 ? baseEvents[baseEvents.length - 1].ts : '1970-01-01T00:00:00Z';
  const actorList = Object.entries(config.policy.actors ?? { planner: 1 });
  const mkCandidates = (minTs) => {
    const out = [];
    for (const [actor, pri] of actorList) {
      out.push({ type: 'freeze', orderId, actor, priority: pri, ts: minTs });
      out.push({ type: 'freeze', orderId, actor, priority: pri, ts: nextTs(minTs) });
    }
    return out;
  };
  let sequences = [[]];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const expanded = [];
    for (const seq of sequences) {
      const minTs = seq.length > 0 ? seq[seq.length - 1].ts : lastTs;
      for (const cand of mkCandidates(minTs)) {
        const trial = [...seq, cand];
        const events = [...baseEvents, ...trial].map((e, i) => ({ ...e, seq: i + 1 }));
        const state = GateState.replay(config, events);
        if (!state.isReleasable(orderId)) {
          return { found: true, orderId, depth, events: trial };
        }
        expanded.push(trial);
      }
    }
    sequences = expanded;
  }
  return { found: false, reason: 'no-counterexample-within-depth', maxDepth };
}
