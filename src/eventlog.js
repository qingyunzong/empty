import { ReplayError } from './errors.js';

export const EVENT_TYPES = new Set(['budget', 'cut', 'measure', 'transition', 'compensate']);

function needString(ev, field, bad) {
  if (typeof ev[field] !== 'string' || ev[field] === '') bad(`${field} must be a non-empty string`);
}

function needLength(ev, field, bad) {
  if (typeof ev[field] !== 'number' || !Number.isFinite(ev[field]) || ev[field] <= 0) {
    bad(`${field} must be a positive finite number`);
  }
}

export function parseLog(text, source = '<log>') {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (s === '' || s.startsWith('#')) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new ReplayError('VALIDATION', `${source}:${i + 1}: invalid JSON`, { line: i + 1 });
    }
    events.push(obj);
  }
  return validateEvents(events);
}

export function validateEvents(events) {
  const ids = new Set();
  events.forEach((ev, i) => {
    const bad = (msg) => {
      throw new ReplayError('VALIDATION', `event[${i}]${ev && ev.id ? ` ${ev.id}` : ''}: ${msg}`, { event: ev });
    };
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) bad('must be an object');
    if (!EVENT_TYPES.has(ev.type)) bad(`unknown type ${JSON.stringify(ev.type)}`);
    needString(ev, 'id', bad);
    if (ids.has(ev.id)) bad(`duplicate id ${ev.id}`);
    ids.add(ev.id);
    if (ev.causes === undefined) ev.causes = [];
    if (!Array.isArray(ev.causes) || ev.causes.some((c) => typeof c !== 'string')) {
      bad('causes must be an array of event ids');
    }
    switch (ev.type) {
      case 'budget':
        if (!['order', 'operation', 'segment'].includes(ev.level)) bad('level must be order|operation|segment');
        needString(ev, 'order', bad);
        if (ev.level !== 'order') needString(ev, 'op', bad);
        if (ev.level === 'segment') needString(ev, 'seg', bad);
        if (typeof ev.limit !== 'number' || !Number.isFinite(ev.limit) || ev.limit < 0) bad('limit must be a number >= 0');
        break;
      case 'cut':
      case 'measure':
        for (const f of ['tool', 'order', 'op', 'seg']) needString(ev, f, bad);
        needLength(ev, 'length', bad);
        break;
      case 'transition':
        needString(ev, 'tool', bad);
        if (!['idle', 'cutting', 'worn', 'locked'].includes(ev.to)) bad('to must be idle|cutting|worn|locked');
        break;
      case 'compensate':
        needString(ev, 'tool', bad);
        needString(ev, 'target', bad);
        break;
      default:
        bad('unreachable');
    }
  });
  for (const ev of events) {
    for (const c of ev.causes) {
      if (!ids.has(c)) throw new ReplayError('VALIDATION', `event ${ev.id} has unknown cause ${c}`, { event: ev.id, cause: c });
    }
  }
  return events;
}

export function topoSort(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const indeg = new Map(events.map((e) => [e.id, (e.causes ?? []).length]));
  const children = new Map(events.map((e) => [e.id, []]));
  for (const e of events) for (const c of e.causes ?? []) children.get(c).push(e.id);
  const ready = events.filter((e) => (e.causes ?? []).length === 0).map((e) => e.id).sort();
  const out = [];
  while (ready.length > 0) {
    const id = ready.shift();
    out.push(byId.get(id));
    for (const ch of children.get(id)) {
      indeg.set(ch, indeg.get(ch) - 1);
      if (indeg.get(ch) === 0) {
        ready.push(ch);
        ready.sort();
      }
    }
  }
  if (out.length !== events.length) throw new ReplayError('VALIDATION', 'causal cycle detected', {});
  return out;
}

export class CausalGraph {
  constructor(events) {
    this.byId = new Map(events.map((e) => [e.id, e]));
    this._anc = new Map();
    for (const e of events) this.ancestors(e.id);
  }

  ancestors(id) {
    if (this._anc.has(id)) return this._anc.get(id);
    const ev = this.byId.get(id);
    const set = new Set();
    for (const c of ev.causes ?? []) {
      set.add(c);
      for (const a of this.ancestors(c)) set.add(a);
    }
    this._anc.set(id, set);
    return set;
  }

  concurrent(a, b) {
    return a !== b && !this.ancestors(a).has(b) && !this.ancestors(b).has(a);
  }
}
