import { createHash } from 'node:crypto';

export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
    this.exitCode = 3;
  }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a, b) {
  return a.ts - b.ts || compareIds(a.id, b.id);
}

function compareCerts(a, b) {
  if (a.pattern !== b.pattern) return compareIds(a.pattern, b.pattern);
  const n = Math.min(a.events.length, b.events.length);
  for (let i = 0; i < n; i += 1) {
    if (a.events[i] !== b.events[i]) return compareIds(a.events[i], b.events[i]);
  }
  return a.events.length - b.events.length;
}

function compilePart(part, patternId, index) {
  const where = `pattern ${JSON.stringify(patternId)} part ${index}`;
  if (part === null || typeof part !== 'object' || Array.isArray(part)) {
    throw new EngineError(`${where}: part must be an object`);
  }
  if (typeof part.lit === 'string') {
    const lit = part.lit;
    return (sym) => sym.includes(lit);
  }
  if (part.any === true) {
    return () => true;
  }
  if (typeof part.re === 'string') {
    let regex;
    try {
      regex = new RegExp(part.re);
    } catch {
      throw new EngineError(`${where}: invalid regex ${JSON.stringify(part.re)}`);
    }
    return (sym) => regex.test(sym);
  }
  throw new EngineError(`${where}: expected one of {lit}, {any:true}, {re}`);
}

export function compilePattern(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    throw new EngineError('pattern definition must be an object');
  }
  if (typeof def.id !== 'string' || def.id.length === 0) {
    throw new EngineError('pattern definition requires a non-empty string id');
  }
  if (!Array.isArray(def.parts) || def.parts.length === 0) {
    throw new EngineError(`pattern ${JSON.stringify(def.id)}: parts must be a non-empty array`);
  }
  return {
    id: def.id,
    size: def.parts.length,
    parts: def.parts.map((part, index) => compilePart(part, def.id, index)),
  };
}

// All index subsequences of `events` whose symbols match the pattern parts,
// in increasing position order. Overlap is allowed; one event may appear in
// any number of matches across patterns (but at most once per match).
export function findMatches(events, pattern) {
  const matches = [];
  const chosen = [];
  const depth = pattern.size;
  function visit(from, partIndex) {
    if (partIndex === depth) {
      matches.push(chosen.slice());
      return;
    }
    const lastStart = events.length - (depth - partIndex);
    for (let i = from; i <= lastStart; i += 1) {
      if (pattern.parts[partIndex](events[i].sym)) {
        chosen.push(events[i].id);
        visit(i + 1, partIndex + 1);
        chosen.pop();
      }
    }
  }
  visit(0, 0);
  return matches;
}

export class Engine {
  constructor(patternDefs) {
    if (!Array.isArray(patternDefs) || patternDefs.length === 0) {
      throw new EngineError('engine requires a non-empty array of pattern definitions');
    }
    this.patterns = patternDefs.map(compilePattern);
    const seen = new Set();
    for (const pattern of this.patterns) {
      if (seen.has(pattern.id)) {
        throw new EngineError(`duplicate pattern id ${JSON.stringify(pattern.id)}`);
      }
      seen.add(pattern.id);
    }
    this.events = new Map();
    this.windowSize = Number.MAX_SAFE_INTEGER;
    this.alarms = new Map();
  }

  windowEvents() {
    const all = [...this.events.values()].sort(compareEvents);
    const start = Math.max(0, all.length - this.windowSize);
    return all.slice(start);
  }

  windowHash(window) {
    return fingerprint({
      n: this.windowSize,
      events: window.map((event) => [event.id, event.ts, event.sym]),
    });
  }

  computeAlarms(window) {
    const alarms = new Map();
    for (const pattern of this.patterns) {
      for (const ids of findMatches(window, pattern)) {
        const matched = ids.map((id) => {
          const event = this.events.get(id);
          return [event.id, event.ts, event.sym];
        });
        alarms.set(JSON.stringify([pattern.id, ...ids]), {
          pattern: pattern.id,
          start: ids[0],
          end: ids[ids.length - 1],
          events: ids,
          fp: fingerprint(matched),
        });
      }
    }
    return alarms;
  }

  apply(op) {
    this.#applyOp(op);
    const window = this.windowEvents();
    const next = this.computeAlarms(window);
    const hash = this.windowHash(window);
    const outputs = [];
    const removed = [];
    for (const [key, cert] of this.alarms) {
      if (!next.has(key)) removed.push(cert);
    }
    const added = [];
    for (const [key, cert] of next) {
      if (!this.alarms.has(key)) added.push(cert);
    }
    removed.sort(compareCerts);
    added.sort(compareCerts);
    for (const cert of removed) outputs.push({ op: 'retractAlarm', cert, windowHash: hash });
    for (const cert of added) outputs.push({ op: 'emit', cert, windowHash: hash });
    this.alarms = next;
    return outputs;
  }

  #applyOp(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new EngineError('operation must be a JSON object');
    }
    const kinds = ['upsert', 'retract', 'setWindow'].filter((kind) => op[kind] !== undefined);
    if (kinds.length !== 1) {
      throw new EngineError('operation must contain exactly one of upsert, retract, setWindow');
    }
    if (op.upsert !== undefined) {
      const event = op.upsert;
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new EngineError('upsert must be an object {id, ts, sym}');
      }
      if (typeof event.id !== 'string' || event.id.length === 0) {
        throw new EngineError('upsert.id must be a non-empty string');
      }
      if (!Number.isInteger(event.ts)) {
        throw new EngineError(`upsert.ts must be an integer, got ${JSON.stringify(event.ts)}`);
      }
      if (typeof event.sym !== 'string') {
        throw new EngineError('upsert.sym must be a string');
      }
      this.events.set(event.id, { id: event.id, ts: event.ts, sym: event.sym });
      return;
    }
    if (op.retract !== undefined) {
      const id = op.retract.id;
      if (typeof id !== 'string' || !this.events.has(id)) {
        throw new EngineError(`retract of unknown id ${JSON.stringify(id)}`);
      }
      this.events.delete(id);
      return;
    }
    const n = op.setWindow.n;
    if (!Number.isInteger(n) || n < 1) {
      throw new EngineError(`setWindow.n must be an integer >= 1, got ${JSON.stringify(n)}`);
    }
    this.windowSize = n;
  }
}
