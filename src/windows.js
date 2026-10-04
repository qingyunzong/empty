import { evaluate, hashAst } from './expr.js';

export function windowInterval(def, T) {
  return { start: T - def.size, end: T, bounds: def.bounds };
}

export function windowKey(name, iv) {
  return `${name}:${iv.start}:${iv.end}:${iv.bounds}`;
}

export function inInterval(ts, iv) {
  const lo = iv.bounds[0] === '[' ? ts >= iv.start : ts > iv.start;
  const hi = iv.bounds[1] === ']' ? ts <= iv.end : ts < iv.end;
  return lo && hi;
}

function emptyPartial() {
  return { sum: 0, count: 0, min: null, max: null };
}

function addValue(p, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return p;
  return {
    sum: p.sum + v,
    count: p.count + 1,
    min: p.min === null || v < p.min ? v : p.min,
    max: p.max === null || v > p.max ? v : p.max,
  };
}

function combine(a, b) {
  return {
    sum: a.sum + b.sum,
    count: a.count + b.count,
    min: a.min === null ? b.min : b.min === null ? a.min : Math.min(a.min, b.min),
    max: a.max === null ? b.max : b.max === null ? a.max : Math.max(a.max, b.max),
  };
}

function finalize(fn, p) {
  switch (fn) {
    case 'count':
      return p.count;
    case 'sum':
      return p.count === 0 ? null : p.sum;
    case 'avg':
      return p.count === 0 ? null : p.sum / p.count;
    case 'min':
      return p.count === 0 ? null : p.min;
    case 'max':
      return p.count === 0 ? null : p.max;
    default:
      return null;
  }
}

export function invalidateAt(caches, windows, ts) {
  for (const def of Object.values(windows)) {
    const perWin = caches.buckets[def.name];
    if (perWin) delete perWin[String(Math.floor(ts / def.hop))];
  }
  for (const key of Object.keys(caches.queries)) {
    if (inInterval(ts, caches.queries[key])) delete caches.queries[key];
  }
}

export class WindowAgg {
  constructor(windows, getObservations, envFor, caches) {
    this.defs = windows;
    this.getObservations = getObservations;
    this.envFor = envFor;
    this.caches = caches;
  }

  aggregate(winName, node, T) {
    const def = this.defs[winName];
    if (!def) throw new Error(`unknown window '${winName}'`);
    const iv = windowInterval(def, T);
    const key = windowKey(winName, iv);
    const exprHash = hashAst(node.arg);
    const aggKey = `${node.fn}:${exprHash}`;
    const cached = this.caches.queries[key];
    if (cached && aggKey in cached.aggs) {
      return { value: cached.aggs[aggKey], windowKey: key };
    }
    const partial = this.computePartial(def, iv, node.arg, exprHash);
    const value = finalize(node.fn, partial);
    const entry = (this.caches.queries[key] ??= {
      start: iv.start,
      end: iv.end,
      bounds: iv.bounds,
      aggs: {},
    });
    entry.aggs[aggKey] = value;
    return { value, windowKey: key };
  }

  computePartial(def, iv, argAst, exprHash) {
    const hop = def.hop;
    const lo = Math.floor(iv.start / hop);
    const hi = Math.floor(iv.end / hop);
    let acc = emptyPartial();
    for (let b = lo; b <= hi; b++) {
      const bs = b * hop;
      const be = bs + hop;
      if (bs > iv.start && be < iv.end) {
        acc = combine(acc, this.bucketPartial(def, b, argAst, exprHash));
      } else {
        for (const obs of this.getObservations()) {
          if (obs.ts >= bs && obs.ts < be && inInterval(obs.ts, iv)) {
            acc = addValue(acc, evaluate(argAst, this.envFor(obs), null));
          }
        }
      }
    }
    return acc;
  }

  bucketPartial(def, b, argAst, exprHash) {
    const perWin = (this.caches.buckets[def.name] ??= {});
    const perBucket = (perWin[String(b)] ??= {});
    if (perBucket[exprHash]) return perBucket[exprHash];
    const bs = b * def.hop;
    const be = bs + def.hop;
    let p = emptyPartial();
    for (const obs of this.getObservations()) {
      if (obs.ts >= bs && obs.ts < be) {
        p = addValue(p, evaluate(argAst, this.envFor(obs), null));
      }
    }
    perBucket[exprHash] = p;
    return p;
  }
}
