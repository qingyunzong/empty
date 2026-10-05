// Shared test helpers (kept outside test/ so node --test does not execute it).

export function ev({ id, member, epoch, seq, kind, valve, clock, ts }) {
  const e = { id, member, epoch, seq, kind, clock };
  if (valve !== undefined) e.valve = valve;
  if (ts !== undefined) e.ts = ts;
  return e;
}

export function* permutations(items) {
  const arr = [...items];
  if (arr.length <= 1) {
    yield arr;
    return;
  }
  for (let i = 0; i < arr.length; i += 1) {
    const head = arr[i];
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const tail of permutations(rest)) yield [head, ...tail];
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, seed) {
  const arr = [...items];
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
