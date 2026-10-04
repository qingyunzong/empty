import { createHash } from 'node:crypto';
import { parse, walk, hashAst, stable, GateError } from './expr.js';

export const AGG_FNS = new Set(['avg', 'sum', 'min', 'max', 'count']);
const BOUNDS = new Set(['[)', '(]', '[]', '()']);

function parseChecked(src, where, code = 'E_RULE') {
  if (typeof src !== 'string' || !src.trim()) {
    throw new GateError(code, `${where}: expression must be a non-empty string`);
  }
  try {
    return parse(src);
  } catch (e) {
    if (e instanceof GateError) throw new GateError(code, `${where}: ${e.message}`);
    throw e;
  }
}

function hasAgg(ast) {
  let found = false;
  walk(ast, (n) => {
    if (n.t === 'agg') found = true;
  });
  return found;
}

export function loadRules(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new GateError('E_RULE', 'rules config must be a JSON object');
  }
  const windows = {};
  for (const [name, def] of Object.entries(config.windows ?? {})) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      throw new GateError('E_WINDOW', `window '${name}': definition must be an object`);
    }
    if (typeof def.size !== 'number' || !Number.isFinite(def.size) || def.size <= 0) {
      throw new GateError('E_WINDOW', `window '${name}': size must be a positive number`);
    }
    const hop = def.hop ?? def.size;
    if (typeof hop !== 'number' || !Number.isFinite(hop) || hop <= 0) {
      throw new GateError('E_WINDOW', `window '${name}': hop must be a positive number`);
    }
    if (def.size % hop !== 0) {
      throw new GateError('E_WINDOW', `window '${name}': size must be a multiple of hop`);
    }
    const bounds = def.bounds ?? '(]';
    if (!BOUNDS.has(bounds)) {
      throw new GateError('E_WINDOW', `window '${name}': bounds must be one of [) (] [] ()`);
    }
    windows[name] = { name, size: def.size, hop, bounds };
  }
  const derived = [];
  for (const [name, src] of Object.entries(config.derived ?? {})) {
    const ast = parseChecked(src, `derived '${name}'`);
    if (hasAgg(ast)) {
      throw new GateError('E_RULE', `derived '${name}': aggregates are not allowed in derived metrics`);
    }
    derived.push({ name, ast, hash: hashAst(ast) });
  }
  const rawRules = config.rules;
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new GateError('E_RULE', 'at least one rule is required');
  }
  const rules = [];
  const ruleIds = new Set();
  for (const r of rawRules) {
    if (!r || typeof r.id !== 'string' || !r.id) {
      throw new GateError('E_RULE', 'every rule requires a non-empty string id');
    }
    if (ruleIds.has(r.id)) throw new GateError('E_RULE', `duplicate rule id '${r.id}'`);
    ruleIds.add(r.id);
    const ast = parseChecked(r.expr, `rule '${r.id}'`);
    const uses = [];
    walk(ast, (n) => {
      if (n.t !== 'agg') return;
      if (!AGG_FNS.has(n.fn)) throw new GateError('E_RULE', `rule '${r.id}': unknown aggregate function '${n.fn}'`);
      if (!n.win) throw new GateError('E_RULE', `rule '${r.id}': aggregate '${n.fn}' requires 'over <window>'`);
      if (!windows[n.win]) throw new GateError('E_WINDOW', `rule '${r.id}': unknown window '${n.win}'`);
      if (hasAgg(n.arg)) throw new GateError('E_RULE', `rule '${r.id}': nested aggregates are not allowed`);
      uses.push(n.win);
    });
    rules.push({ id: r.id, ast, hash: hashAst(ast), windows: uses });
  }
  const exemptions = [];
  const exIds = new Set();
  for (const e of config.exemptions ?? []) {
    if (!e || typeof e.id !== 'string' || !e.id) {
      throw new GateError('E_EXEMPT', 'every exemption requires a non-empty string id');
    }
    if (exIds.has(e.id)) throw new GateError('E_EXEMPT', `duplicate exemption id '${e.id}'`);
    exIds.add(e.id);
    const priority = e.priority ?? 0;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw new GateError('E_EXEMPT', `exemption '${e.id}': priority must be a finite number`);
    }
    if (!Array.isArray(e.rules) || e.rules.length === 0) {
      throw new GateError('E_EXEMPT', `exemption '${e.id}': rules must be a non-empty array`);
    }
    for (const rid of e.rules) {
      if (rid !== '*' && !ruleIds.has(rid)) {
        throw new GateError('E_EXEMPT', `exemption '${e.id}': unknown rule '${rid}'`);
      }
    }
    const when = e.when === undefined ? null : parseChecked(e.when, `exemption '${e.id}' when`, 'E_EXEMPT');
    if (when && hasAgg(when)) {
      throw new GateError('E_EXEMPT', `exemption '${e.id}': aggregates are not allowed in 'when'`);
    }
    const from = e.from ?? null;
    const until = e.until ?? null;
    if ((from !== null && (typeof from !== 'number' || !Number.isFinite(from))) ||
        (until !== null && (typeof until !== 'number' || !Number.isFinite(until)))) {
      throw new GateError('E_EXEMPT', `exemption '${e.id}': from/until must be finite numbers`);
    }
    if (from !== null && until !== null && from > until) {
      throw new GateError('E_EXEMPT', `exemption '${e.id}': from must be <= until`);
    }
    exemptions.push({ id: e.id, priority, rules: e.rules, when, from, until });
  }
  const rulesHash = createHash('sha256')
    .update(
      stable({
        windows,
        derived: derived.map((d) => ({ name: d.name, hash: d.hash })),
        rules: rules.map((r) => ({ id: r.id, hash: r.hash })),
        exemptions: exemptions.map((e) => ({
          id: e.id,
          priority: e.priority,
          rules: e.rules,
          when: e.when ? hashAst(e.when) : null,
          from: e.from,
          until: e.until,
        })),
      }),
    )
    .digest('hex');
  return { windows, derived, rules, exemptions, rulesHash };
}
