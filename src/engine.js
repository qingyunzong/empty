import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GateError } from './errors.js';
import { evaluate, validateExpr, hashExpr } from './expr.js';
import { WindowIndex, WindowCache, aggregate } from './windows.js';

export const CERT_VERSION = 1;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function collectWindowDefs(node, defs) {
  if (node === null || typeof node !== 'object') return;
  if ('agg' in node) {
    const bounds = node.window.bounds ?? 'left-open';
    const def = { agg: node.agg, window: { size: node.window.size, bounds }, expr: node.expr };
    defs.set(hashExpr(def), def);
    collectWindowDefs(node.expr, defs);
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => collectWindowDefs(v, defs));
    else if (value !== null && typeof value === 'object') collectWindowDefs(value, defs);
  }
}

export function validateRules(rules) {
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new GateError('E_RULE', 'rules file must contain a JSON object');
  }
  const derived = rules.derived ?? {};
  if (typeof derived !== 'object' || Array.isArray(derived)) {
    throw new GateError('E_RULE', 'derived must be an object mapping name -> expression');
  }
  const hasAgg = (node) => {
    if (node === null || typeof node !== 'object') return false;
    if ('agg' in node) return true;
    return Object.values(node).some((v) => (Array.isArray(v) ? v.some(hasAgg) : hasAgg(v)));
  };
  for (const [name, expr] of Object.entries(derived)) {
    validateExpr(expr, `derived.${name}`);
    if (hasAgg(expr)) {
      throw new GateError('E_RULE', `derived.${name}: windowed aggregation is not allowed in derived metrics`);
    }
  }
  // Derived metrics may reference other derived metrics; reject cycles.
  const refsOf = (node, acc = new Set()) => {
    if (node === null || typeof node !== 'object') return acc;
    if ('ref' in node) acc.add(node.ref);
    if ('agg' in node) refsOf(node.expr, acc);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ref') continue;
      if (Array.isArray(v)) v.forEach((x) => refsOf(x, acc));
      else if (v !== null && typeof v === 'object') refsOf(v, acc);
    }
    return acc;
  };
  const visit = (name, stack) => {
    if (stack.includes(name)) {
      throw new GateError('E_RULE', `derived metric cycle: ${[...stack, name].join(' -> ')}`);
    }
    if (!(name in derived)) return;
    for (const ref of refsOf(derived[name])) visit(ref, [...stack, name]);
  };
  Object.keys(derived).forEach((name) => visit(name, []));

  const ruleList = rules.rules ?? [];
  if (!Array.isArray(ruleList)) throw new GateError('E_RULE', 'rules must be an array');
  const ruleIds = new Set();
  for (const [i, rule] of ruleList.entries()) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new GateError('E_RULE', `rules[${i}].id: non-empty string required`);
    }
    if (ruleIds.has(rule.id)) throw new GateError('E_RULE', `duplicate rule id: ${rule.id}`);
    ruleIds.add(rule.id);
    validateExpr(rule.when, `rules[${i}].when`);
  }

  const exemptions = rules.exemptions ?? [];
  if (!Array.isArray(exemptions)) throw new GateError('E_RULE', 'exemptions must be an array');
  const exemptionIds = new Set();
  for (const [i, ex] of exemptions.entries()) {
    if (typeof ex.id !== 'string' || ex.id.length === 0) {
      throw new GateError('E_RULE', `exemptions[${i}].id: non-empty string required`);
    }
    if (exemptionIds.has(ex.id)) throw new GateError('E_RULE', `duplicate exemption id: ${ex.id}`);
    exemptionIds.add(ex.id);
    if (ex.priority !== undefined && (!Number.isInteger(ex.priority))) {
      throw new GateError('E_RULE', `exemptions[${i}].priority: integer required`);
    }
    if (ex.rules !== undefined && ex.rules !== '*') {
      if (!Array.isArray(ex.rules)) throw new GateError('E_RULE', `exemptions[${i}].rules: array or "*" required`);
      for (const rid of ex.rules) {
        if (!ruleIds.has(rid)) throw new GateError('E_RULE', `exemptions[${i}] references unknown rule: ${rid}`);
      }
    }
    if (ex.match !== undefined) validateExpr(ex.match, `exemptions[${i}].match`);
    if (ex.expiresAt !== undefined && typeof ex.expiresAt !== 'number') {
      throw new GateError('E_RULE', `exemptions[${i}].expiresAt: number (ms epoch) required`);
    }
  }
  return { derived, rules: ruleList, exemptions };
}

export class Engine {
  static init(dir, rulesObj, { force = false } = {}) {
    if (existsSync(join(dir, 'rules.json')) && !force) {
      throw new GateError('E_RULE', `gate already initialized at ${dir} (use --force to reinitialize)`);
    }
    const normalized = validateRules(rulesObj);
    mkdirSync(dir, { recursive: true });
    const defs = new Map();
    for (const expr of Object.values(normalized.derived)) collectWindowDefs(expr, defs);
    for (const rule of normalized.rules) collectWindowDefs(rule.when, defs);
    for (const ex of normalized.exemptions) if (ex.match) collectWindowDefs(ex.match, defs);
    writeJson(join(dir, 'rules.json'), rulesObj);
    writeJson(join(dir, 'observations.json'), {});
    writeJson(join(dir, 'state.json'), {
      defs: Object.fromEntries(defs),
      indexes: {},
      cache: {},
      stats: { ingested: 0, corrections: 0, windowsComputed: 0, cacheHits: 0, windowsInvalidated: 0 },
    });
    writeFileSync(join(dir, 'decisions.jsonl'), '');
    writeFileSync(join(dir, 'corrections.jsonl'), '');
    return new Engine(dir);
  }

  constructor(dir) {
    this.dir = dir;
    if (!existsSync(join(dir, 'rules.json'))) {
      throw new GateError('E_RULE', `no gate initialized at ${dir} (run: gate init <rules.json>)`);
    }
    this.rules = validateRules(readJson(join(dir, 'rules.json')));
    this.rulesHash = hashExpr(readJson(join(dir, 'rules.json')));
    this.observations = readJson(join(dir, 'observations.json'));
    const state = readJson(join(dir, 'state.json'));
    this.defs = state.defs;
    this.indexes = new Map(Object.entries(state.indexes).map(([k, entries]) => [k, new WindowIndex(entries)]));
    this.cache = new WindowCache(state.cache);
    this.stats = state.stats;
  }

  save() {
    writeJson(join(this.dir, 'observations.json'), this.observations);
    writeJson(join(this.dir, 'state.json'), {
      defs: this.defs,
      indexes: Object.fromEntries([...this.indexes].map(([k, idx]) => [k, idx.entries])),
      cache: this.cache.toJSON(),
      stats: this.stats,
    });
  }

  // Derived metrics resolve lazily and memoized, so they may reference other
  // derived metrics in any declaration order (cycles are rejected at init).
  derivedFor(obs) {
    const memo = {};
    const resolving = new Set();
    const fields = new Proxy({ ...obs }, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (typeof prop === 'string' && prop in this.rules.derived) {
          if (prop in memo) return memo[prop];
          if (resolving.has(prop)) throw new GateError('E_RULE', `derived metric cycle at ${prop}`);
          resolving.add(prop);
          memo[prop] = evaluate(this.rules.derived[prop], fields, () => null);
          resolving.delete(prop);
          return memo[prop];
        }
        return undefined;
      },
    });
    for (const name of Object.keys(this.rules.derived)) void fields[name];
    return memo;
  }

  evalDefValue(def, obs) {
    const fields = { ...obs, ...this.derivedFor(obs) };
    const v = evaluate(def.expr, fields, () => null);
    return typeof v === 'number' && !Number.isNaN(v) ? v : null;
  }

  indexFor(defKey) {
    let idx = this.indexes.get(defKey);
    if (!idx) {
      idx = new WindowIndex();
      for (const obs of Object.values(this.observations)) {
        idx.insert({ t: obs.time, k: obs.key, v: this.evalDefValue(this.defs[defKey], obs) });
      }
      this.indexes.set(defKey, idx);
    }
    return idx;
  }

  validateObs(obs) {
    if (obs === null || typeof obs !== 'object' || Array.isArray(obs)) {
      throw new GateError('E_OBS', 'observation must be a JSON object');
    }
    if (typeof obs.key !== 'string' || obs.key.length === 0) {
      throw new GateError('E_OBS', 'observation.key: non-empty string required');
    }
    if (typeof obs.time !== 'number' || !Number.isFinite(obs.time)) {
      throw new GateError('E_OBS', `observation ${obs.key}: time must be a finite number (ms epoch)`);
    }
  }

  ingest(obsList) {
    for (const obs of obsList) {
      this.validateObs(obs);
      if (obs.key in this.observations) {
        throw new GateError('E_OBS', `duplicate observation key: ${obs.key} (use: gate correct)`);
      }
    }
    for (const obs of obsList) {
      this.observations[obs.key] = obs;
      // Only update indexes that already exist; missing ones are built lazily
      // from the observation log on first use (which includes these rows).
      for (const [defKey, def] of Object.entries(this.defs)) {
        const idx = this.indexes.get(defKey);
        if (idx) idx.insert({ t: obs.time, k: obs.key, v: this.evalDefValue(def, obs) });
      }
      this.stats.ingested += 1;
    }
    this.save();
    return obsList.length;
  }

  makeEvalWindow(anchorObs, collected, counters) {
    return (node) => {
      const bounds = node.window.bounds ?? 'left-open';
      const def = { agg: node.agg, window: { size: node.window.size, bounds }, expr: node.expr };
      const defKey = hashExpr(def);
      const end = anchorObs.time;
      const start = end - node.window.size;
      collected.push(`w:${defKey}:${bounds === 'closed' ? '[' : '('}${start},${end}]`);
      const cached = this.cache.get(defKey, start, end);
      if (cached !== undefined) {
        counters.hits += 1;
        this.stats.cacheHits += 1;
        return cached;
      }
      counters.misses += 1;
      this.stats.windowsComputed += 1;
      const result = aggregate(node.agg, this.indexFor(defKey).stats(start, end, bounds));
      this.cache.set(defKey, start, end, bounds, result);
      return result;
    };
  }

  decide(key, { mode = 'incremental', persist = true } = {}) {
    const obs = this.observations[key];
    if (!obs) throw new GateError('E_OBS', `unknown observation key: ${key}`);
    const fields = { ...obs, ...this.derivedFor(obs) };
    const windowKeys = [];
    const counters = { hits: 0, misses: 0 };
    const evalWindow = this.makeEvalWindow(obs, windowKeys, counters);

    const ruleResults = [];
    const exemptionChain = [];
    for (const rule of this.rules.rules) {
      const before = windowKeys.length;
      const value = evaluate(rule.when, fields, evalWindow);
      const result = {
        id: rule.id,
        value,
        outcome: value === true ? 'pass' : value === false ? 'fail' : 'undecided',
        astHash: hashExpr(rule.when),
        windowKeys: windowKeys.slice(before),
        exemptions: [],
      };
      if (result.outcome === 'fail') {
        const matches = this.rules.exemptions.filter((ex) => {
          const applies = ex.rules === '*' || ex.rules === undefined || ex.rules.includes(rule.id);
          const alive = ex.expiresAt === undefined || obs.time <= ex.expiresAt;
          const matched = ex.match === undefined || evaluate(ex.match, fields, evalWindow) === true;
          return applies && alive && matched;
        });
        if (matches.length > 0) {
          const top = Math.max(...matches.map((ex) => ex.priority ?? 0));
          const winners = matches.filter((ex) => (ex.priority ?? 0) === top);
          if (winners.length > 1) {
            throw new GateError('E_EXEMPT',
              `exemption conflict for rule ${rule.id}: ${winners.map((w) => w.id).join(', ')} tie at priority ${top}`);
          }
          const winner = winners[0];
          result.outcome = 'exempt';
          result.exemptions.push({ id: winner.id, priority: winner.priority ?? 0, reason: winner.reason ?? null });
          exemptionChain.push({ ruleId: rule.id, exemptionId: winner.id, priority: winner.priority ?? 0 });
        }
      }
      ruleResults.push(result);
    }

    const outcomes = ruleResults.map((r) => r.outcome);
    const decision = outcomes.includes('fail') ? 'fail' : outcomes.includes('undecided') ? 'undecided' : 'pass';
    const cert = {
      certVersion: CERT_VERSION,
      key,
      time: obs.time,
      decision,
      admissible: decision === 'pass',
      violation: decision === 'fail',
      rulesHash: this.rulesHash,
      rules: ruleResults,
      windowKeys: [...new Set(windowKeys)],
      exemptionChain,
      cache: { hits: counters.hits, misses: counters.misses },
      mode,
      decidedAt: Date.now(),
    };
    if (persist) {
      appendFileSync(join(this.dir, 'decisions.jsonl'), `${JSON.stringify(cert)}\n`);
      this.save();
    }
    return cert;
  }

  correct(key, patch) {
    const obs = this.observations[key];
    if (!obs) throw new GateError('E_OBS', `unknown observation key: ${key}`);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new GateError('E_OBS', 'patch must be a JSON object');
    }
    if ('key' in patch && patch.key !== key) {
      throw new GateError('E_OBS', 'patch cannot change observation key');
    }
    const next = { ...obs, ...patch, key };
    this.validateObs(next);
    const oldTime = obs.time;
    this.observations[key] = next;
    for (const [defKey, def] of Object.entries(this.defs)) {
      const idx = this.indexes.get(defKey);
      if (!idx) continue; // lazy build on first use picks up the correction
      idx.removeByKey(key);
      idx.insert({ t: next.time, k: key, v: this.evalDefValue(def, next) });
    }
    // Only windows overlapping the old or new position of this observation
    // can change; everything else stays valid.
    this.stats.windowsInvalidated += this.cache.invalidateOverlapping([oldTime, next.time]);
    this.stats.corrections += 1;
    appendFileSync(join(this.dir, 'corrections.jsonl'),
      `${JSON.stringify({ key, patch, oldTime, newTime: next.time, at: Date.now() })}\n`);
    return this.decide(key);
  }

  replay(from, to) {
    if (!(Number.isFinite(from) && Number.isFinite(to)) || from > to) {
      throw new GateError('E_WINDOW', `invalid replay range: from=${from} to=${to}`);
    }
    // Full recompute from the observation log: rebuild every index and drop
    // all cached window results, then re-decide in time order.
    this.indexes = new Map();
    this.cache.clear();
    for (const defKey of Object.keys(this.defs)) this.indexFor(defKey);
    const keys = Object.values(this.observations)
      .filter((obs) => obs.time >= from && obs.time <= to)
      .sort((a, b) => a.time - b.time || (a.key < b.key ? -1 : 1))
      .map((obs) => obs.key);
    const certs = keys.map((key) => this.decide(key, { mode: 'replay' }));
    this.save();
    return certs;
  }
}
