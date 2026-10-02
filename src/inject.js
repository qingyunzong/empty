// Deterministic fault injection. A spec may use explicit ids or counts; counts are
// resolved with a seeded PRNG, and the resolved spec is returned so runs are
// replayable and can be embedded in the certificate.

export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// spec: {
//   seed?: number,
//   lost?: number | [id, ...],
//   duplicate?: number | [id, ...] | [{ id, times }, ...],
//   skew?: { count, maxDeltaMs } | [{ id, deltaMs }, ...]
// }
export function injectFaults(events, spec = {}) {
  const seed = spec.seed ?? 1;
  const rand = mulberry32(seed);
  const ids = events.map((e) => String(e.id));
  const pick = (n) => {
    const pool = [...ids];
    const out = [];
    while (out.length < n && pool.length > 0) {
      out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    return out;
  };

  const lost = Array.isArray(spec.lost) ? spec.lost.map(String) : pick(spec.lost ?? 0);

  let duplicate;
  if (Array.isArray(spec.duplicate)) {
    duplicate = spec.duplicate.map((d) =>
      typeof d === 'object' && d !== null ? { id: String(d.id), times: d.times ?? 1 } : { id: String(d), times: 1 },
    );
  } else {
    duplicate = pick(spec.duplicate ?? 0).map((id) => ({ id, times: 1 }));
  }

  let skew;
  if (Array.isArray(spec.skew)) {
    skew = spec.skew.map((s) => ({ id: String(s.id), deltaMs: s.deltaMs }));
  } else if (spec.skew && typeof spec.skew === 'object') {
    const { count = 0, maxDeltaMs = 0 } = spec.skew;
    skew = pick(count).map((id) => ({ id, deltaMs: Math.round((rand() * 2 - 1) * maxDeltaMs) }));
  } else {
    skew = [];
  }

  const byId = new Map(events.map((e) => [String(e.id), e]));
  const skewOf = new Map(skew.map((s) => [s.id, s.deltaMs]));

  let out = [];
  for (const ev of events) {
    if (lost.includes(String(ev.id))) continue;
    const delta = skewOf.get(String(ev.id)) ?? 0;
    out.push({ ...ev, start: ev.start + delta, end: ev.end + delta });
  }
  for (const d of duplicate) {
    const orig = byId.get(d.id);
    if (!orig || lost.includes(d.id)) continue;
    const delta = skewOf.get(d.id) ?? 0;
    for (let t = 0; t < d.times; t++) {
      out.push({ ...orig, start: orig.start + delta, end: orig.end + delta }); // exact copy, same id
    }
  }

  return { events: out, injection: { seed, lost, duplicate, skew } };
}
