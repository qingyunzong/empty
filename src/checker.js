import { DslError, DslErrorList } from './errors.js';

class Scope {
  constructor(parent, label) {
    this.parent = parent;
    this.label = label;
    this.signals = new Map();
  }

  lookup(name) {
    let scope = this;
    while (scope) {
      if (scope.signals.has(name)) return scope.signals.get(name);
      scope = scope.parent;
    }
    return null;
  }
}

export function typeName(type) {
  if (type.kind === 'enum') return type.name;
  return type.kind;
}

function sameType(a, b) {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'enum' || a.name === b.name;
}

export function check(program) {
  const errors = [];
  const err = (message, node) => {
    errors.push(new DslError(message, node && node.line !== undefined ? node.line : 1, node && node.col !== undefined ? node.col : 1));
  };

  // Pass 1: enums (global namespace).
  const enums = new Map();
  for (const e of program.enums) {
    if (enums.has(e.name)) {
      err(`duplicate enum '${e.name}'`, e);
      continue;
    }
    const seen = new Set();
    const values = [];
    for (const v of e.values) {
      if (seen.has(v.value)) err(`duplicate value '${v.value}' in enum '${e.name}'`, v);
      else { seen.add(v.value); values.push(v.value); }
    }
    enums.set(e.name, { name: e.name, values });
  }

  // Pass 2: signals with lexical scopes (global scope + one scope per device).
  const globalScope = new Scope(null, 'global');
  const allSignals = [];

  const resolveType = (sig) => {
    if (sig.type.kind === 'enum') {
      const en = enums.get(sig.type.name);
      if (!en) {
        err(`unknown enum '${sig.type.name}'`, sig.type);
        return { kind: 'bool' };
      }
      return { kind: 'enum', name: en.name, values: en.values };
    }
    return { kind: sig.type.kind };
  };

  const literalValue = (lit, type) => {
    if (type.kind === 'bool') {
      if (lit.kind !== 'bool') { err(`expected a bool literal but found '${lit.value ?? lit.name}'`, lit); return false; }
      return lit.value;
    }
    if (type.kind === 'ms') {
      if (lit.kind !== 'duration') { err(`expected a duration literal (e.g. 500ms) but found '${lit.value ?? lit.name}'`, lit); return 0; }
      return lit.value;
    }
    // enum
    if (lit.kind !== 'enumLit' || !type.values.includes(lit.name)) {
      err(`expected a value of enum '${type.name}' (${type.values.join(', ')}) but found '${lit.name ?? lit.value}'`, lit);
      return type.values[0];
    }
    return lit.name;
  };

  const declareSignal = (sig, scope, deviceName) => {
    const type = resolveType(sig);
    if (sig.sigKind === 'timer' && type.kind !== 'ms') {
      err(`timer '${sig.name}' must have type ms`, sig);
    }
    if (sig.sigKind !== 'timer' && type.kind === 'ms') {
      err(`${sig.sigKind} '${sig.name}' cannot have type ms; declare it as a timer`, sig);
    }
    if (scope.signals.has(sig.name)) {
      err(`duplicate signal '${sig.name}' in ${scope.label} scope`, sig);
    }
    const init = sig.init
      ? literalValue(sig.init, type)
      : (type.kind === 'bool' ? false : type.kind === 'ms' ? 0 : type.values[0]);
    const rec = {
      name: sig.name,
      label: deviceName ? `${deviceName}.${sig.name}` : sig.name,
      kind: sig.sigKind,
      type,
      init,
      index: allSignals.length,
    };
    scope.signals.set(sig.name, rec);
    allSignals.push(rec);
    return rec;
  };

  for (const sig of program.signals) declareSignal(sig, globalScope, null);

  const deviceScopes = new Map();
  for (const dev of program.devices) {
    const scope = new Scope(globalScope, `device '${dev.name}'`);
    deviceScopes.set(dev, scope);
    for (const sig of dev.signals) declareSignal(sig, scope, dev.name);
  }

  // Pass 3: expressions (guards and invariants) with scope-chain resolution.
  const checkExpr = (node, scope) => {
    switch (node.kind) {
      case 'bool':
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
      case 'duration':
        node.resolvedType = { kind: 'ms' };
        return node.resolvedType;
      case 'name': {
        const sig = scope.lookup(node.name);
        if (sig) {
          node.kind = 'ref';
          node.index = sig.index;
          node.resolvedType = sig.type;
          return sig.type;
        }
        const found = [...enums.values()].filter((e) => e.values.includes(node.name));
        if (found.length === 1) {
          node.kind = 'enumLit';
          node.resolvedType = { kind: 'enum', name: found[0].name, values: found[0].values };
          return node.resolvedType;
        }
        if (found.length > 1) {
          err(`ambiguous enum literal '${node.name}' (defined in ${found.map((e) => e.name).join(', ')})`, node);
          node.kind = 'enumLit';
          node.resolvedType = { kind: 'enum', name: found[0].name, values: found[0].values };
          return node.resolvedType;
        }
        err(`undefined name '${node.name}'`, node);
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
      }
      case 'not': {
        const t = checkExpr(node.expr, scope);
        if (t.kind !== 'bool') err(`'not' expects a bool operand but found ${typeName(t)}`, node);
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
      }
      case 'and':
      case 'or': {
        const lt = checkExpr(node.left, scope);
        const rt = checkExpr(node.right, scope);
        if (lt.kind !== 'bool') err(`'${node.kind}' expects bool operands but left side is ${typeName(lt)}`, node);
        if (rt.kind !== 'bool') err(`'${node.kind}' expects bool operands but right side is ${typeName(rt)}`, node);
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
      }
      case 'cmp': {
        const lt = checkExpr(node.left, scope);
        const rt = checkExpr(node.right, scope);
        if (node.op === '==' || node.op === '!=') {
          if (!sameType(lt, rt)) {
            err(`cannot compare ${typeName(lt)} with ${typeName(rt)} using '${node.op}'`, node);
          }
        } else if (lt.kind !== 'ms' || rt.kind !== 'ms') {
          err(`'${node.op}' expects ms operands but found ${typeName(lt)} and ${typeName(rt)}`, node);
        }
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
      }
      default:
        err(`internal: unknown expression kind '${node.kind}'`, node);
        node.resolvedType = { kind: 'bool' };
        return node.resolvedType;
    }
  };

  // Pass 4: rules.
  const checkedRules = [];
  for (const dev of program.devices) {
    const scope = deviceScopes.get(dev);
    for (const rule of dev.rules) {
      const guardType = checkExpr(rule.guard, scope);
      if (guardType.kind !== 'bool') {
        err(`guard of rule '${rule.name}' must be bool but is ${typeName(guardType)}`, rule);
      }
      const target = scope.lookup(rule.target);
      if (!target) {
        err(`undefined signal '${rule.target}' in rule '${rule.name}'`, { line: rule.targetLine, col: rule.targetCol });
        continue;
      }
      if (target.kind !== 'output') {
        err(`rule '${rule.name}' cannot set ${target.kind} signal '${rule.target}'; only outputs can be set`, { line: rule.targetLine, col: rule.targetCol });
        continue;
      }
      const value = literalValue(rule.value, target.type);
      checkedRules.push({ name: rule.name, guard: rule.guard, targetIndex: target.index, value });
    }
  }

  // Pass 5: invariants.
  const checkedInvariants = [];
  for (const inv of program.invariants) {
    const t = checkExpr(inv.expr, globalScope);
    if (t.kind !== 'bool') {
      err(`invariant must be a bool expression but is ${typeName(t)}`, inv);
    }
    checkedInvariants.push({ expr: inv.expr });
  }

  if (errors.length > 0) throw new DslErrorList(errors);

  return {
    signals: allSignals,
    rules: checkedRules,
    invariants: checkedInvariants,
  };
}
