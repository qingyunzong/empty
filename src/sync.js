import { vvCompare, vvMerge } from './vvector.js';

// Merge two snapshots (dispatch db + feedback db) per key.
// - Dominant version vector wins.
// - Concurrent: deterministic rule for normal keys (higher counter sum,
//   tie -> lexicographically larger nodeId in the vv, tie -> value compare).
// - Safety-critical keys with concurrent edits are NEVER auto-resolved:
//   they land in `pending`.
export function mergeSnapshots(schema, a, b) {
  const merged = { nodeId: a.nodeId, seq: Math.max(a.seq || 0, b.seq || 0), params: {} };
  const pending = [];
  for (const [key, def] of schema.params) {
    const pa = a.params[key];
    const pb = b.params[key];
    if (!pa && !pb) continue;
    if (!pa) { merged.params[key] = clone(pb); continue; }
    if (!pb) { merged.params[key] = clone(pa); continue; }
    const rel = vvCompare(pa.vv || {}, pb.vv || {});
    if (rel === 'gt' || rel === 'eq') {
      merged.params[key] = withMergedVv(pa, pb);
    } else if (rel === 'lt') {
      merged.params[key] = withMergedVv(pb, pa);
    } else if (def.safety) {
      // Safety-critical conflict: keep local (dispatch side) value, flag pending.
      merged.params[key] = clone(pa);
      pending.push({
        key,
        a: { value: pa.value, vv: pa.vv },
        b: { value: pb.value, vv: pb.vv },
        reason: 'safety-critical concurrent modification',
      });
    } else {
      const winner = deterministicWinner(key, pa, pb);
      const loser = winner === pa ? pb : pa;
      merged.params[key] = withMergedVv(winner, loser);
    }
  }
  return { merged, pending };
}

function clone(p) {
  return { value: p.value, locked: !!p.locked, vv: { ...(p.vv || {}) } };
}

function withMergedVv(winner, loser) {
  return { value: winner.value, locked: winner.locked, vv: vvMerge(winner.vv || {}, loser.vv || {}) };
}

function deterministicWinner(key, pa, pb) {
  const sa = counterSum(pa.vv);
  const sb = counterSum(pb.vv);
  if (sa !== sb) return sa > sb ? pa : pb;
  const na = maxNode(pa.vv);
  const nb = maxNode(pb.vv);
  if (na !== nb) return na > nb ? pa : pb;
  const va = JSON.stringify(pa.value);
  const vb = JSON.stringify(pb.value);
  return va >= vb ? pa : pb;
}

function counterSum(vv) {
  return Object.values(vv || {}).reduce((a, b) => a + b, 0);
}

function maxNode(vv) {
  const ids = Object.keys(vv || {}).filter((k) => vv[k] > 0);
  return ids.length ? ids.sort().at(-1) : '';
}
