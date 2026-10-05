import { EXIT, ReplayError } from './errors.js';

export const EVENT_TYPES = ['measure', 'cut', 'tool_change', 'compensate'];

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

export function validateEvents(events) {
  if (!Array.isArray(events)) throw new ReplayError(EXIT.USAGE, 'event log must be an array');
  const byId = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new ReplayError(EXIT.USAGE, 'each event must be an object');
    }
    if (!isNonEmptyString(ev.id)) throw new ReplayError(EXIT.USAGE, 'event id must be a non-empty string');
    if (byId.has(ev.id)) throw new ReplayError(EXIT.USAGE, `duplicate event id ${ev.id}`);
    if (!EVENT_TYPES.includes(ev.type)) throw new ReplayError(EXIT.USAGE, `event ${ev.id}: unknown type ${ev.type}`);
    if (ev.deps === undefined) ev.deps = [];
    if (!Array.isArray(ev.deps) || ev.deps.some((d) => !isNonEmptyString(d))) {
      throw new ReplayError(EXIT.USAGE, `event ${ev.id}: deps must be an array of event ids`);
    }
    if (ev.type === 'measure' || ev.type === 'cut') {
      for (const field of ['tool', 'order', 'op', 'seg']) {
        if (!isNonEmptyString(ev[field])) {
          throw new ReplayError(EXIT.USAGE, `event ${ev.id}: ${field} must be a non-empty string`);
        }
      }
      if (typeof ev.length !== 'number' || !Number.isFinite(ev.length) || ev.length <= 0) {
        throw new ReplayError(EXIT.USAGE, `event ${ev.id}: length must be a positive finite number`);
      }
    } else if (ev.type === 'tool_change') {
      if (!isNonEmptyString(ev.tool)) throw new ReplayError(EXIT.USAGE, `event ${ev.id}: tool must be a non-empty string`);
    } else if (ev.type === 'compensate') {
      if (!isNonEmptyString(ev.target)) throw new ReplayError(EXIT.USAGE, `event ${ev.id}: target must be a non-empty string`);
    }
    byId.set(ev.id, ev);
  }
  for (const ev of events) {
    for (const dep of ev.deps) {
      if (!byId.has(dep)) {
        throw new ReplayError(EXIT.TRANSITION, `causal guard rejected ${ev.id}: unknown dependency ${dep}`, { event: ev.id, missing: dep });
      }
    }
  }
  topoSort(events);
  return byId;
}

export function topoSort(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const indeg = new Map(events.map((e) => [e.id, e.deps.length]));
  const children = new Map(events.map((e) => [e.id, []]));
  for (const e of events) {
    for (const dep of e.deps) {
      if (children.has(dep)) children.get(dep).push(e.id);
    }
  }
  const ready = events.filter((e) => e.deps.length === 0).map((e) => e.id).sort();
  const out = [];
  while (ready.length > 0) {
    const id = ready.shift();
    out.push(byId.get(id));
    for (const child of children.get(id)) {
      indeg.set(child, indeg.get(child) - 1);
      if (indeg.get(child) === 0) {
        const at = ready.findIndex((x) => x > child);
        if (at === -1) ready.push(child);
        else ready.splice(at, 0, child);
      }
    }
  }
  if (out.length !== events.length) {
    throw new ReplayError(EXIT.TRANSITION, 'causal guard rejected log: dependency cycle detected', {});
  }
  return out;
}

export function computePasts(byId) {
  const pasts = new Map();
  const visit = (id) => {
    if (pasts.has(id)) return pasts.get(id);
    const ev = byId.get(id);
    const set = new Set([id]);
    for (const dep of ev.deps) {
      for (const x of visit(dep)) set.add(x);
    }
    pasts.set(id, set);
    return set;
  };
  for (const id of byId.keys()) visit(id);
  return pasts;
}

export function isConcurrent(a, b, pastOf) {
  return a.id !== b.id && !pastOf.get(a.id).has(b.id) && !pastOf.get(b.id).has(a.id);
}

export function interactionKeys(ev, byId) {
  if (ev.type === 'measure' || ev.type === 'cut') {
    return [
      `tool:${ev.tool}`,
      `seg:${ev.order}/${ev.op}/${ev.seg}`,
      `op:${ev.order}/${ev.op}`,
      `order:${ev.order}`,
    ];
  }
  if (ev.type === 'tool_change') return [`tool:${ev.tool}`];
  if (ev.type === 'compensate') {
    const target = byId.get(ev.target);
    return target ? interactionKeys(target, byId) : [];
  }
  return [];
}

export function linearExtensions(events, byId, cap = 200000) {
  const children = new Map(events.map((e) => [e.id, []]));
  const indeg = new Map(events.map((e) => [e.id, e.deps.length]));
  for (const e of events) {
    for (const dep of e.deps) children.get(dep).push(e.id);
  }
  const results = [];
  const prefix = [];
  const backtrack = (ready) => {
    if (results.length >= cap) return;
    if (ready.length === 0) {
      results.push(prefix.map((id) => byId.get(id)));
      return;
    }
    for (const id of ready) {
      prefix.push(id);
      const next = ready.filter((x) => x !== id);
      for (const child of children.get(id)) {
        indeg.set(child, indeg.get(child) - 1);
        if (indeg.get(child) === 0) next.push(child);
      }
      next.sort();
      backtrack(next);
      for (const child of children.get(id)) indeg.set(child, indeg.get(child) + 1);
      prefix.pop();
    }
  };
  backtrack(events.filter((e) => e.deps.length === 0).map((e) => e.id).sort());
  return results;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
