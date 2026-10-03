// Shared object-model semantics: JSON equality, the read/write register
// validity check, and commutation-closure validity.

export function jsonEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => jsonEq(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && jsonEq(a[k], b[k]));
}

export function pairKey(idA, idB) {
  return idA < idB ? `${idA}${idB}` : `${idB}${idA}`;
}

function seqKey(seq) {
  return seq.map((e) => e.id).join('');
}

// A sequence is register-valid when every `gets` op observes the value most
// recently written by a `sets` op to the same key (null when never written).
export function registerValid(seq, effects) {
  const state = new Map();
  for (const ev of seq) {
    const eff = effects[ev.op] || { kind: 'none' };
    if (eff.kind === 'sets') {
      state.set(ev[eff.keyField], ev[eff.valueField]);
    } else if (eff.kind === 'gets') {
      const key = ev[eff.keyField];
      const cur = state.has(key) ? state.get(key) : null;
      if (!jsonEq(cur, ev.value)) return false;
    }
  }
  return true;
}

// A sequence is valid up to commutation when some sequence reachable by
// swapping adjacent commuting operations is register-valid.
export function validUpToCommutation(seq, commKeySet, effects, cap = 200000) {
  if (registerValid(seq, effects)) return true;
  const seen = new Set([seqKey(seq)]);
  const queue = [seq];
  while (queue.length > 0) {
    if (seen.size > cap) return false;
    const s = queue.shift();
    for (let i = 0; i + 1 < s.length; i++) {
      if (!commKeySet.has(pairKey(s[i].id, s[i + 1].id))) continue;
      const t = s.slice();
      [t[i], t[i + 1]] = [t[i + 1], t[i]];
      const k = seqKey(t);
      if (seen.has(k)) continue;
      if (registerValid(t, effects)) return true;
      seen.add(k);
      queue.push(t);
    }
  }
  return false;
}
