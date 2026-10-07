export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, seed) {
  const arr = [...list];
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const p of permutations(rest)) out.push([list[i], ...p]);
  }
  return out;
}

export function scenario() {
  return [
    { id: 'a1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
    { id: 'b1', member: 'beta', epoch: 1, seq: 1, type: 'join', clock: { beta: 1 } },
    { id: 'g1', member: 'gamma', epoch: 1, seq: 1, type: 'join', clock: { gamma: 1 } },
    { id: 'a2', member: 'alpha', epoch: 1, seq: 2, type: 'interlock', clock: { alpha: 2 } },
    { id: 'b2', member: 'beta', epoch: 1, seq: 2, type: 'bypass', key: 'fw-1', clock: { alpha: 2, beta: 2 } },
    { id: 'g2', member: 'gamma', epoch: 1, seq: 2, type: 'unbypass', key: 'fw-1', clock: { alpha: 2, gamma: 2 } },
    { id: 'a3', member: 'alpha', epoch: 1, seq: 3, type: 'reset', clock: { alpha: 3, beta: 2, gamma: 2 } },
    { id: 'b3', member: 'beta', epoch: 1, seq: 3, type: 'interlock', clock: { alpha: 3, beta: 3, gamma: 2 } },
    { id: 'g3', member: 'gamma', epoch: 1, seq: 3, type: 'bypass', key: 'fw-2', clock: { alpha: 3, beta: 3, gamma: 3 } },
  ];
}
