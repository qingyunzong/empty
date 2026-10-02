'use strict';

const crypto = require('node:crypto');

const LEVELS = ['public', 'internal', 'confidential', 'secret'];

class ReportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    this.details = details || {};
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function canonicalHash(value) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function levelIndex(level) {
  const i = LEVELS.indexOf(level);
  if (i < 0) throw new ReportError('E_INPUT', `unknown classification level: ${level}`);
  return i;
}

function rolePaths(spec, role) {
  const roles = spec.roles || {};
  if (!Object.prototype.hasOwnProperty.call(roles, role)) {
    throw new ReportError('E_INPUT', `unknown role: ${role}`);
  }
  const paths = new Map();
  const stack = [[role, [role]]];
  while (stack.length) {
    const [current, path] = stack.pop();
    if (paths.has(current)) continue;
    paths.set(current, path);
    const parents = (roles[current] && roles[current].parents) || [];
    for (const parent of parents) {
      if (path.includes(parent)) {
        throw new ReportError('E_INPUT', `role inheritance cycle at: ${parent}`);
      }
      if (!Object.prototype.hasOwnProperty.call(roles, parent)) {
        throw new ReportError('E_INPUT', `unknown parent role: ${parent}`);
      }
      stack.push([parent, [...path, parent]]);
    }
  }
  return paths;
}

function sourceClosure(spec, rootId) {
  const units = spec.units || {};
  if (!Object.prototype.hasOwnProperty.call(units, rootId)) {
    throw new ReportError('E_INPUT', `unknown unit: ${rootId}`);
  }
  const result = new Set();
  const stack = [[rootId, [rootId]]];
  while (stack.length) {
    const [id, path] = stack.pop();
    result.add(id);
    const sources = (units[id] && units[id].sources) || [];
    for (const s of sources) {
      if (path.includes(s)) {
        throw new ReportError('E_INPUT', `unit dependency cycle at: ${s}`);
      }
      if (!Object.prototype.hasOwnProperty.call(units, s)) {
        throw new ReportError('E_INPUT', `unknown source unit: ${s}`);
      }
      if (!result.has(s)) stack.push([s, [...path, s]]);
    }
  }
  return [...result].sort();
}

function effectiveAccess(spec, role, unitId) {
  const paths = rolePaths(spec, role);
  const grants = spec.grants || [];
  let deny = null;
  let allow = null;
  for (const [r, path] of paths) {
    for (const g of grants) {
      if (g.role !== r || g.unit !== unitId) continue;
      if (g.effect === 'deny' && !deny) deny = { via: 'deny', role: r, path };
      if (g.effect === 'allow' && !allow) allow = { via: 'allow', role: r, path };
    }
  }
  if (deny) return { ok: false, reason: deny };
  if (allow) return { ok: true, rule: allow };
  const unitLevel = levelIndex((spec.units[unitId] && spec.units[unitId].level) || 'public');
  for (const [r, path] of paths) {
    const clearance = spec.roles[r] && spec.roles[r].clearance;
    if (clearance && levelIndex(clearance) >= unitLevel) {
      return { ok: true, rule: { via: 'clearance', role: r, path } };
    }
  }
  return { ok: false, reason: { via: 'default-deny', role, path: paths.get(role) } };
}

function authorize(spec) {
  const request = spec.request;
  if (!request || !request.role || !request.unit) {
    throw new ReportError('E_INPUT', 'spec.request requires role and unit');
  }
  const closure = sourceClosure(spec, request.unit);
  const maskRules = new Map();
  for (const rule of spec.masks || []) maskRules.set(rule.id, rule);
  const requestedMasks = [];
  for (const req of request.masks || []) {
    const rule = maskRules.get(req.rule);
    if (!rule) throw new ReportError('E_MASK', `mask rule not found: ${req.rule}`, { rule: req.rule });
    if (rule.revoked) throw new ReportError('E_MASK', `mask rule revoked: ${req.rule}`, { rule: req.rule });
    if (rule.version !== req.version) {
      throw new ReportError('E_MASK',
        `mask rule ${req.rule} version mismatch: requested ${req.version}, current ${rule.version}`,
        { rule: req.rule, requested: req.version, current: rule.version });
    }
    requestedMasks.push(rule);
  }
  const rulePath = [];
  const unauthorized = [];
  const masked = new Map();
  for (const unitId of closure) {
    if (unitId === request.unit) continue;
    const access = effectiveAccess(spec, request.role, unitId);
    if (access.ok) {
      rulePath.push({ unit: unitId, decision: 'allow', ...access.rule });
      continue;
    }
    const rule = requestedMasks.find((m) => m.unit === unitId);
    if (rule) {
      masked.set(unitId, rule);
      rulePath.push({ unit: unitId, decision: 'mask', rule: rule.id, field: rule.field, version: rule.version });
    } else {
      unauthorized.push({ unit: unitId, reason: access.reason });
    }
  }
  if (unauthorized.length) {
    const minimal = unauthorized.map((u) => u.unit).sort();
    throw new ReportError('E_DENY', `unauthorized sources: ${minimal.join(', ')}`,
      { minimal, reasons: unauthorized });
  }
  return { closure, rulePath, masked };
}

function buildOutput(spec, closure, masked) {
  const sources = {};
  const totals = {};
  for (const unitId of closure) {
    if (unitId === spec.request.unit) continue;
    const unit = spec.units[unitId];
    const data = JSON.parse(JSON.stringify(unit.data || {}));
    const rule = masked.get(unitId);
    if (rule) data[rule.field] = '***MASKED***';
    sources[unitId] = data;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
    }
  }
  return { unit: spec.request.unit, role: spec.request.role, sources, totals };
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new ReportError('E_INPUT', 'spec must be an object');
  for (const name of Object.keys(spec.roles || {})) rolePaths(spec, name);
  for (const id of Object.keys(spec.units || {})) {
    const unit = spec.units[id];
    if (unit.level) levelIndex(unit.level);
  }
}

function buildReport(spec) {
  validateSpec(spec);
  const auth = authorize(spec);
  const output = buildOutput(spec, auth.closure, auth.masked);
  const snapshot = JSON.parse(JSON.stringify(spec));
  const proof = {
    closure: auth.closure,
    rulePath: auth.rulePath,
    canonicalHash: canonicalHash({ snapshot, output }),
  };
  return { version: 1, request: spec.request, snapshot, output, proof };
}

function verifyReport(report) {
  if (!report || typeof report !== 'object') throw new ReportError('E_INPUT', 'invalid report');
  const { snapshot, output, proof } = report;
  if (!snapshot || !output || !proof) {
    throw new ReportError('E_INPUT', 'report missing snapshot/output/proof');
  }
  let expected;
  try {
    const auth = authorize(snapshot);
    expected = { closure: auth.closure, output: buildOutput(snapshot, auth.closure, auth.masked) };
  } catch (err) {
    if (err instanceof ReportError && err.code === 'E_DENY') {
      throw new ReportError('E_DENY', `proof recomputation failed: ${err.message}`, err.details);
    }
    throw err;
  }
  if (canonicalize(expected.closure) !== canonicalize(proof.closure)) {
    throw new ReportError('E_PROOF', 'closure mismatch between proof and snapshot');
  }
  if (canonicalize(expected.output) !== canonicalize(output)) {
    throw new ReportError('E_HASH', 'output does not match recomputation from snapshot');
  }
  const hash = canonicalHash({ snapshot, output });
  if (hash !== proof.canonicalHash) {
    throw new ReportError('E_HASH', 'canonical hash mismatch');
  }
  return { ok: true, closure: proof.closure, canonicalHash: hash };
}

module.exports = {
  LEVELS,
  ReportError,
  canonicalize,
  canonicalHash,
  rolePaths,
  sourceClosure,
  effectiveAccess,
  authorize,
  buildReport,
  verifyReport,
};
