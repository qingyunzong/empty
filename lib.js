'use strict';

// 财务共享中心监管报表:授权证明与可重算汇总核心库。
// 语义:
// - 数据单元有密级(level),角色有 clearance,角色经 DAG inherits 继承。
// - 授权判定:显式 deny 优先于一切;其次显式 allow;否则按闭包内最大 clearance >= 单元密级。
// - 汇总单元可见 当且仅当 每个来源(叶子闭包)可读,或被版本匹配的显式脱敏规则覆盖。
// - 脱敏规则必须指定 unit/field/version/roles;版本不匹配 -> E_MASK。
// - 证明内嵌快照(角色/授权/脱敏/来源数据),撤销脱敏不追溯已签发报表。

const crypto = require('node:crypto');

class ReportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    if (details !== undefined) this.details = details;
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

function levelIndex(levels, level) {
  const i = levels.indexOf(level);
  if (i === -1) throw new ReportError('E_SPEC', `unknown classification level: ${level}`);
  return i;
}

// 角色闭包:自身 + 沿 inherits 可达的全部祖先(BFS,自身在前)。检测环与未知角色。
function roleClosure(roles, start) {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new ReportError('E_SPEC', 'roles must be an object');
  }
  if (!Object.prototype.hasOwnProperty.call(roles, start)) {
    throw new ReportError('E_SPEC', `unknown role: ${start}`);
  }
  for (const [name, def] of Object.entries(roles)) {
    for (const parent of def.inherits || []) {
      if (!Object.prototype.hasOwnProperty.call(roles, parent)) {
        throw new ReportError('E_SPEC', `role ${name} inherits unknown role: ${parent}`);
      }
    }
  }
  const color = new Map();
  const dfs = (r) => {
    const c = color.get(r) || 0;
    if (c === 1) throw new ReportError('E_CYCLE', `role inheritance cycle involving: ${r}`);
    if (c === 2) return;
    color.set(r, 1);
    for (const p of roles[r].inherits || []) dfs(p);
    color.set(r, 2);
  };
  dfs(start);
  const order = [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const r = queue.shift();
    order.push(r);
    for (const p of roles[r].inherits || []) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return order;
}

// 单点授权判定。返回 { decision: 'allow'|'deny', via, rolePath }。
function decide(spec, role, unitId) {
  const roles = spec.roles || {};
  const levels = spec.levels || [];
  const unit = (spec.units || {})[unitId];
  if (!unit) throw new ReportError('E_SPEC', `unknown unit: ${unitId}`);
  const rolePath = roleClosure(roles, role);
  const inClosure = new Set(rolePath);
  const grants = (spec.grants || []).filter((g) => g.unit === unitId && inClosure.has(g.role));
  const denies = grants.filter((g) => g.effect === 'deny');
  if (denies.length > 0) {
    return { decision: 'deny', via: `explicit-deny(${denies.map((g) => g.role).join(',')})`, rolePath };
  }
  const allows = grants.filter((g) => g.effect === 'allow');
  if (allows.length > 0) {
    return { decision: 'allow', via: `explicit-allow(${allows.map((g) => g.role).join(',')})`, rolePath };
  }
  let maxClearance = -1;
  let clearanceFrom = null;
  for (const r of rolePath) {
    const c = roles[r].clearance;
    if (c !== undefined && c !== null) {
      const idx = levelIndex(levels, c);
      if (idx > maxClearance) {
        maxClearance = idx;
        clearanceFrom = r;
      }
    }
  }
  const unitLevel = unit.level !== undefined ? levelIndex(levels, unit.level) : -1;
  if (maxClearance >= unitLevel) {
    return { decision: 'allow', via: `clearance(${clearanceFrom})`, rolePath };
  }
  return { decision: 'deny', via: 'insufficient-clearance', rolePath };
}

// 汇总单元来源闭包:递归展开嵌套汇总,返回叶子数据单元 id(排序)。检测环。
function sourceClosure(spec, unitId) {
  const units = spec.units || {};
  if (!units[unitId]) throw new ReportError('E_SPEC', `unknown unit: ${unitId}`);
  const leaves = new Set();
  const color = new Map();
  const visit = (id) => {
    const u = units[id];
    if (!u) throw new ReportError('E_SPEC', `unknown source unit: ${id}`);
    const c = color.get(id) || 0;
    if (c === 1) throw new ReportError('E_CYCLE', `aggregate source cycle involving: ${id}`);
    if (c === 2) return;
    color.set(id, 1);
    if (u.aggregate) {
      for (const s of u.sources || []) visit(s);
    } else {
      leaves.add(id);
    }
    color.set(id, 2);
  };
  visit(unitId);
  return [...leaves].sort();
}

// 查找角色闭包内适用于某单元的脱敏规则。
function masksFor(spec, unitId, rolePath) {
  const inClosure = new Set(rolePath);
  return (spec.masks || []).filter(
    (m) => m.unit === unitId && Array.isArray(m.roles) && m.roles.some((r) => inClosure.has(r))
  );
}

function validateMask(mask) {
  for (const key of ['id', 'unit', 'field', 'version', 'roles']) {
    if (mask[key] === undefined) {
      throw new ReportError('E_SPEC', `mask rule missing required key: ${key}`);
    }
  }
}

// 计算汇总字段:数值字段跨叶子求和;被脱敏规则覆盖的 (unit, field) 跳过。
function computeFields(sourceData, leafIds, usedMasks) {
  const masked = new Set(usedMasks.map((m) => `${m.unit}.${m.field}`));
  const fields = {};
  for (const id of leafIds) {
    const data = sourceData[id].fields || {};
    for (const [k, v] of Object.entries(data)) {
      if (masked.has(`${id}.${k}`)) continue;
      if (typeof v === 'number') fields[k] = (fields[k] || 0) + v;
    }
  }
  return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// 对叶子集合做授权评估,返回 { rulePath, usedMasks, failures }。
function evaluate(spec, role, leafIds) {
  const rulePath = [];
  const usedMasks = [];
  const failures = [];
  for (const id of leafIds) {
    const unit = spec.units[id];
    const d = decide(spec, role, id);
    if (d.decision === 'allow') {
      rulePath.push({ unit: id, decision: 'allow', via: d.via, rolePath: d.rolePath });
      continue;
    }
    const candidates = masksFor(spec, id, d.rolePath);
    candidates.forEach(validateMask);
    const valid = candidates.filter((m) => m.version === unit.version);
    if (valid.length > 0) {
      const m = valid[0];
      usedMasks.push(m);
      rulePath.push({
        unit: id,
        decision: 'mask',
        maskId: m.id,
        field: m.field,
        version: m.version,
        rolePath: d.rolePath,
      });
      continue;
    }
    if (candidates.length > 0) {
      failures.push({
        unit: id,
        reason: 'mask-version-mismatch',
        maskId: candidates[0].id,
        maskVersion: candidates[0].version,
        unitVersion: unit.version,
      });
      rulePath.push({ unit: id, decision: 'deny', via: 'mask-version-mismatch', rolePath: d.rolePath });
    } else {
      failures.push({ unit: id, reason: d.via });
      rulePath.push({ unit: id, decision: 'deny', via: d.via, rolePath: d.rolePath });
    }
  }
  return { rulePath, usedMasks, failures };
}

function throwIfFailures(failures) {
  if (failures.length === 0) return;
  const minimalSet = failures.map((f) => f.unit).sort();
  const hasMaskMismatch = failures.some((f) => f.reason === 'mask-version-mismatch');
  const code = hasMaskMismatch ? 'E_MASK' : 'E_AUTH';
  throw new ReportError(code, `aggregate not visible: minimal over-authority set = [${minimalSet.join(', ')}]`, {
    minimalSet,
    failures,
  });
}

// 签发报表。spec.request = { unit, role }。失败抛 ReportError(E_AUTH/E_MASK/...)。
function buildReport(spec, request) {
  if (!spec || typeof spec !== 'object') throw new ReportError('E_SPEC', 'spec must be an object');
  const { unit, role } = request || {};
  if (!unit || !role) throw new ReportError('E_SPEC', 'request requires { unit, role }');
  const agg = (spec.units || {})[unit];
  if (!agg) throw new ReportError('E_SPEC', `unknown unit: ${unit}`);
  if (!agg.aggregate) throw new ReportError('E_SPEC', `unit is not an aggregate: ${unit}`);

  const leaves = sourceClosure(spec, unit);
  const { rulePath, usedMasks, failures } = evaluate(spec, role, leaves);
  throwIfFailures(failures);

  const sourceData = {};
  for (const id of leaves) {
    const u = spec.units[id];
    sourceData[id] = { level: u.level, version: u.version, fields: u.fields || {} };
  }
  const fields = computeFields(sourceData, leaves, usedMasks);

  const report = {
    format: 'regreport/1',
    unit,
    role,
    fields,
    proof: {
      sourceClosure: leaves,
      rulePath,
      maskSnapshot: usedMasks,
      grantSnapshot: spec.grants || [],
      roleSnapshot: spec.roles || {},
      levels: spec.levels || [],
      sourceData,
    },
  };
  report.proof.canonicalHash = canonicalHash(report);
  return report;
}

// 从证明内嵌快照重建最小 spec(verify 自包含,不读取当前 spec.json)。
function specFromProof(report) {
  const p = report.proof;
  const units = {};
  for (const [id, d] of Object.entries(p.sourceData)) {
    units[id] = { level: d.level, version: d.version, fields: d.fields };
  }
  return {
    levels: p.levels,
    roles: p.roleSnapshot,
    grants: p.grantSnapshot,
    masks: p.maskSnapshot,
    units,
  };
}

// 验证报表:1) canonical 哈希;2) 依据内嵌快照重估授权;3) 重算汇总字段。
function verifyReport(report) {
  if (!report || typeof report !== 'object') throw new ReportError('E_PARSE', 'report must be an object');
  if (report.format !== 'regreport/1') throw new ReportError('E_PARSE', `unsupported format: ${report.format}`);
  const p = report.proof;
  if (!p || typeof p !== 'object') throw new ReportError('E_PARSE', 'report missing proof');
  for (const key of ['sourceClosure', 'rulePath', 'maskSnapshot', 'grantSnapshot', 'roleSnapshot', 'sourceData', 'canonicalHash']) {
    if (p[key] === undefined) throw new ReportError('E_PARSE', `proof missing key: ${key}`);
  }

  const claimed = p.canonicalHash;
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.proof.canonicalHash;
  const actual = canonicalHash(copy);
  if (actual !== claimed) {
    throw new ReportError('E_HASH', 'canonical hash mismatch: report was tampered with', { claimed, actual });
  }

  const spec = specFromProof(report);
  const leaves = p.sourceClosure;
  const { failures } = evaluate(spec, report.role, leaves);
  throwIfFailures(failures);

  const recomputed = computeFields(p.sourceData, leaves, p.maskSnapshot);
  if (canonicalize(recomputed) !== canonicalize(report.fields)) {
    throw new ReportError('E_RECOMPUTE', 'aggregate fields do not recompute from source snapshot', {
      claimed: report.fields,
      recomputed,
    });
  }

  return { ok: true, unit: report.unit, role: report.role, sources: leaves.length, hash: claimed };
}

module.exports = {
  ReportError,
  canonicalize,
  canonicalHash,
  roleClosure,
  decide,
  sourceClosure,
  computeFields,
  buildReport,
  verifyReport,
};
