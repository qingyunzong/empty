import { RiskError } from './errors.js';
import { parseMoney, parseCount } from './money.js';
import { cidrSubnetOf } from './ip.js';

export const FIELD_TYPES = {
  id: 'string',
  time: 'string',
  merchant: 'string',
  channel: 'string',
  ip: 'ip',
  amount: 'money',
  count: 'count',
};

class Scope {
  constructor(kind, arg, parent) {
    this.kind = kind;
    this.arg = arg;
    this.parent = parent;
    this.thresholds = new Map();
    this.whitelists = new Map();
    this.rules = [];
    this.children = [];
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.thresholds.has(name)) return { kind: 'threshold', ...s.thresholds.get(name) };
      if (s.whitelists.has(name)) return { kind: 'whitelist', value: s.whitelists.get(name) };
    }
    return null;
  }
}

export function scopePath(scope) {
  const parts = [];
  for (let s = scope; s && s.kind !== 'root'; s = s.parent) {
    parts.unshift(s.kind === 'global' ? 'global' : `${s.kind}("${s.arg}")`);
  }
  return parts.join('/');
}

export function checkProgram(ast) {
  return { versions: ast.versions.map(checkVersion) };
}

function checkVersion(v) {
  const root = new Scope('root', null, null);
  const checked = { id: v.id, since: v.since, sinceMs: v.sinceMs, root, overrides: [] };
  for (const decl of v.body) {
    if (decl.kind !== 'scope') {
      throw new RiskError('E_PARSE', 'declarations must be nested inside a scope block', decl.pos);
    }
    checkScope(decl, root, checked);
  }
  return checked;
}

function checkScope(decl, parent, checked) {
  const scope = new Scope(decl.scopeKind, decl.arg, parent);
  parent.children.push(scope);
  for (const d of decl.body) {
    if (d.kind === 'scope') checkScope(d, scope, checked);
    else if (d.kind === 'threshold') checkThreshold(d, scope, checked);
    else if (d.kind === 'whitelist') scope.whitelists.set(d.name, d.regex);
    else if (d.kind === 'rule') checkRule(d, scope);
  }
}

function checkThreshold(decl, scope, checked) {
  if (scope.thresholds.has(decl.name)) {
    throw new RiskError('E_OVERRIDE', `duplicate threshold "${decl.name}" in the same scope`, decl.pos);
  }
  let value;
  let display;
  if (decl.type === 'money') {
    value = parseMoney(decl.value.raw, decl.pos);
    display = decl.value.raw;
  } else if (decl.type === 'count') {
    value = parseCount(decl.value.raw, decl.pos);
    display = decl.value.raw;
  } else {
    value = { base: decl.value.base, prefix: decl.value.prefix };
    display = decl.value.display;
  }
  let outer = null;
  for (let s = scope.parent; s; s = s.parent) {
    if (s.thresholds.has(decl.name)) {
      outer = { ...s.thresholds.get(decl.name) };
      break;
    }
  }
  if (!outer) {
    if (decl.override) {
      throw new RiskError('E_OVERRIDE', `override of threshold "${decl.name}" has no outer declaration`, decl.pos);
    }
  } else {
    if (!decl.override) {
      throw new RiskError(
        'E_OVERRIDE',
        `threshold "${decl.name}" shadows an outer declaration; explicit "override" is required`,
        decl.pos,
      );
    }
    if (outer.type !== decl.type) {
      throw new RiskError(
        'E_TYPE',
        `override of threshold "${decl.name}" changes type ${outer.type} -> ${decl.type}`,
        decl.pos,
      );
    }
    const tightened =
      decl.type === 'cidr' ? cidrSubnetOf(value, outer.value) : value <= outer.value;
    if (!tightened) {
      throw new RiskError(
        'E_OVERRIDE',
        `override of threshold "${decl.name}" loosens the outer value (${outer.display} -> ${display}); inner scopes may only tighten`,
        decl.pos,
      );
    }
    checked.overrides.push({
      version: checked.id,
      scope: scopePath(scope),
      name: decl.name,
      type: decl.type,
      outer: outer.display,
      inner: display,
    });
  }
  scope.thresholds.set(decl.name, { type: decl.type, value, display });
}

function checkRule(decl, scope) {
  const t = checkExpr(decl.expr, scope);
  if (t !== 'bool') {
    throw new RiskError('E_TYPE', `rule "${decl.id}" condition must be boolean, got ${t}`, decl.pos);
  }
  scope.rules.push({ id: decl.id, expr: decl.expr, decision: decl.decision, pos: decl.pos });
}

function coerceNum(node, target, pos) {
  if (target !== 'money' && target !== 'count') {
    throw new RiskError('E_TYPE', `cannot use a number literal where ${target} is expected`, pos);
  }
  const value = target === 'money' ? parseMoney(node.raw, node.pos) : parseCount(node.raw, node.pos);
  node.kind = 'const';
  node.ctype = target;
  node.value = value;
  delete node.raw;
  return target;
}

function coerceRange(node, target, pos) {
  const parse = target === 'money' ? parseMoney : parseCount;
  const lo = parse(node.lo, node.pos);
  const hi = parse(node.hi, node.pos);
  if (lo > hi) {
    throw new RiskError('E_TYPE', `empty range ${node.lo}..${node.hi}`, pos);
  }
  node.kind = 'const';
  node.ctype = `${target}_range`;
  node.value = [lo, hi];
  delete node.lo;
  delete node.hi;
}

function resolvePair(node, scope) {
  let lt = checkExpr(node.l, scope);
  let rt = checkExpr(node.r, scope);
  if (lt === 'number' && rt !== 'number') lt = coerceNum(node.l, rt, node.pos);
  else if (rt === 'number' && lt !== 'number') rt = coerceNum(node.r, lt, node.pos);
  else if (lt === 'number' && rt === 'number') {
    lt = coerceNum(node.l, 'count', node.pos);
    rt = coerceNum(node.r, 'count', node.pos);
  }
  return [lt, rt];
}

function checkExpr(node, scope) {
  switch (node.kind) {
    case 'num':
      return 'number';
    case 'str':
      return 'string';
    case 'boollit':
      return 'bool';
    case 'regex':
      return 'regex';
    case 'range':
      return 'range';
    case 'ip':
      node.kind = 'const';
      node.ctype = 'ip';
      return 'ip';
    case 'cidr':
      node.kind = 'const';
      node.ctype = 'cidr';
      node.value = { base: node.base, prefix: node.prefix };
      delete node.base;
      delete node.prefix;
      return 'cidr';
    case 'field': {
      const t = FIELD_TYPES[node.name];
      if (!t) {
        throw new RiskError('E_TYPE', `unknown event field "event.${node.name}"`, node.pos);
      }
      return t;
    }
    case 'ref': {
      const found = scope.lookup(node.name);
      if (!found) {
        throw new RiskError('E_TYPE', `unknown name "${node.name}"`, node.pos);
      }
      if (found.kind === 'threshold') {
        node.kind = 'const';
        node.ctype = found.type;
        node.value = found.value;
        return found.type;
      }
      node.kind = 'const';
      node.ctype = 'regex';
      node.value = found.value;
      return 'regex';
    }
    case 'not': {
      const t = checkExpr(node.e, scope);
      if (t !== 'bool') {
        throw new RiskError('E_TYPE', `"not" expects a boolean operand, got ${t}`, node.pos);
      }
      return 'bool';
    }
    case 'bin': {
      if (node.op === 'and' || node.op === 'or') {
        const lt = checkExpr(node.l, scope);
        const rt = checkExpr(node.r, scope);
        if (lt !== 'bool' || rt !== 'bool') {
          throw new RiskError('E_TYPE', `"${node.op}" expects boolean operands, got ${lt} and ${rt}`, node.pos);
        }
        return 'bool';
      }
      const [lt, rt] = resolvePair(node, scope);
      if (node.op === '==' || node.op === '!=') {
        if (lt !== rt || !['money', 'count', 'string', 'ip'].includes(lt)) {
          throw new RiskError('E_TYPE', `cannot compare ${lt} with ${rt} using "${node.op}"`, node.pos);
        }
        return 'bool';
      }
      const orderable =
        (lt === 'money' && rt === 'money') || (lt === 'count' && rt === 'count');
      if (!orderable) {
        throw new RiskError('E_TYPE', `cannot compare ${lt} with ${rt} using "${node.op}"`, node.pos);
      }
      return 'bool';
    }
    case 'in': {
      let lt = checkExpr(node.l, scope);
      const rt = checkExpr(node.r, scope);
      if (lt === 'number' && rt === 'range') lt = coerceNum(node.l, 'count', node.pos);
      if (lt === 'ip' && rt === 'cidr') {
        node.inKind = 'cidr';
        return 'bool';
      }
      if (lt === 'string' && rt === 'regex') {
        node.inKind = 'regex';
        return 'bool';
      }
      if ((lt === 'money' || lt === 'count') && rt === 'range') {
        coerceRange(node.r, lt, node.pos);
        node.inKind = 'range';
        return 'bool';
      }
      throw new RiskError('E_TYPE', `"in" does not support "${lt} in ${rt}"`, node.pos);
    }
    default:
      throw new RiskError('E_TYPE', `internal: unknown expression kind ${node.kind}`, node.pos);
  }
}
