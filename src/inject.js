// Replayable fault injection. Given a seed and a spec, deterministically
// mutate an event stream with skew / lost / duplicate faults. Every mutation
// is appended to a log that can be replayed verbatim and is embedded in the
// analysis certificate.

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

function pickIndices(rng, length, count) {
  const idx = [...Array(length).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.max(0, Math.min(count, length))).sort((a, b) => a - b);
}

// spec:
//   skew:      [{ id, deltaMs }] | { count, maxDeltaMs }
//   lost:      [id, ...]         | { count }
//   duplicate: [{ id, times }]   | { count }
// Faults apply in a fixed order: skew -> lost -> duplicate.
export function injectFaults(events, spec = {}, seed = 1) {
  const rng = mulberry32(seed >>> 0);
  const out = events.map((e) => ({ ...e }));
  const byId = new Map(out.map((e) => [e.id, e]));
  const log = [];

  if (spec.skew) {
    const entries = Array.isArray(spec.skew)
      ? spec.skew.map((s) => ({ id: s.id, deltaMs: s.deltaMs }))
      : pickIndices(rng, out.length, spec.skew.count ?? 1).map((i) => ({
          id: out[i].id,
          deltaMs: Math.round((rng() * 2 - 1) * (spec.skew.maxDeltaMs ?? 60000)),
        }));
    for (const { id, deltaMs } of entries) {
      const e = byId.get(id);
      if (!e) continue;
      const before = { start: e.start, end: e.end };
      e.start += deltaMs;
      e.end += deltaMs;
      log.push({ op: 'skew', id, deltaMs, before, after: { start: e.start, end: e.end } });
    }
  }

  if (spec.lost) {
    const ids = Array.isArray(spec.lost)
      ? spec.lost
      : pickIndices(rng, out.length, spec.lost.count ?? 1).map((i) => out[i].id);
    for (const id of ids) {
      const i = out.findIndex((e) => e.id === id);
      if (i === -1) continue;
      const [removed] = out.splice(i, 1);
      byId.delete(id);
      log.push({ op: 'lost', id, removed });
    }
  }

  if (spec.duplicate) {
    const entries = Array.isArray(spec.duplicate)
      ? spec.duplicate.map((d) => ({ id: d.id, times: d.times ?? 1 }))
      : pickIndices(rng, out.length, spec.duplicate.count ?? 1).map((i) => ({ id: out[i].id, times: 1 }));
    for (const { id, times } of entries) {
      const src = byId.get(id);
      if (!src) continue;
      for (let k = 1; k <= times; k++) {
        const copy = { ...src, id: `${id}#dup${k}` };
        out.push(copy);
        byId.set(copy.id, copy);
        log.push({ op: 'duplicate', id, copyId: copy.id, copy: { ...copy } });
      }
    }
  }

  return { events: out, log };
}

// Deterministically re-apply an injection log to the original events.
export function replayInjections(events, log) {
  const out = events.map((e) => ({ ...e }));
  const byId = new Map(out.map((e) => [e.id, e]));
  for (const entry of log) {
    if (entry.op === 'skew') {
      const e = byId.get(entry.id);
      if (e) {
        e.start = entry.after.start;
        e.end = entry.after.end;
      }
    } else if (entry.op === 'lost') {
      const i = out.findIndex((e) => e.id === entry.id);
      if (i !== -1) {
        out.splice(i, 1);
        byId.delete(entry.id);
      }
    } else if (entry.op === 'duplicate') {
      const copy = { ...entry.copy };
      out.push(copy);
      byId.set(copy.id, copy);
    }
  }
  return out;
}
