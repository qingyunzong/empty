import { DslError } from './errors.js';

// Static types: quantity (count), ratio (exact fraction), level (ordered
// defect severity), date, batch, bool.

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();
  }

  declare(name, type) {
    this.vars.set(name, type);
  }

  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.vars.has(name)) return scope.vars.get(name);
    }
    return null;
  }

  declaresLocally(name) {
    return this.vars.has(name);
  }
}

const ORDERABLE = new Set(['quantity', 'ratio', 'level', 'date']);

export function checkRule(rule, filename = '<input>') {
  const fail = (msg, line) => {
    throw new DslError(`${filename}:${line}: ${msg}`, line);
  };

  const globalScope = new Scope(null);

  for (const param of rule.params) {
    if (globalScope.declaresLocally(param.name)) {
      fail(`duplicate parameter '${param.name}'`, param.line);
    }
    globalScope.declare(param.name, param.type);
  }

  for (const c of rule.consts) {
    if (globalScope.declaresLocally(c.name)) {
      fail(`duplicate declaration of '${c.name}'`, c.line);
    }
    const inferred = checkExpr(c.expr, globalScope, fail);
    if (c.declaredType && c.declaredType !== inferred) {
      fail(`const '${c.name}' is declared as ${c.declaredType} but has type ${inferred}`, c.line);
    }
    c.resolvedType = inferred;
    globalScope.declare(c.name, inferred);
  }

  for (const clause of rule.clauses) {
    // Each `when` clause opens a new lexical scope for its `let` bindings;
    // inner bindings shadow (never mutate) the outer scope.
    const clauseScope = new Scope(globalScope);
    for (const binding of clause.lets) {
      if (clauseScope.declaresLocally(binding.name)) {
        fail(`duplicate let binding '${binding.name}'`, binding.line);
      }
      const inferred = checkExpr(binding.expr, clauseScope, fail);
      if (binding.declaredType && binding.declaredType !== inferred) {
        fail(`let '${binding.name}' is declared as ${binding.declaredType} but has type ${inferred}`, binding.line);
      }
      binding.resolvedType = inferred;
      clauseScope.declare(binding.name, inferred);
    }
    const condType = checkExpr(clause.cond, clauseScope, fail);
    if (condType !== 'bool') {
      fail(`'when' condition must be a boolean, got ${condType}`, clause.line);
    }
  }
}

function checkExpr(node, scope, fail) {
  switch (node.kind) {
    case 'lit':
      node.exprType = node.litType;
      return node.exprType;

    case 'ident': {
      const type = scope.lookup(node.name);
      if (!type) fail(`unknown identifier '${node.name}'`, node.line);
      node.exprType = type;
      return type;
    }

    case 'un': {
      const inner = checkExpr(node.expr, scope, fail);
      if (node.op === 'not') {
        if (inner !== 'bool') fail(`'not' requires a boolean operand, got ${inner}`, node.line);
        node.exprType = 'bool';
      } else {
        if (inner !== 'quantity') fail(`unary '-' requires a quantity, got ${inner}`, node.line);
        node.exprType = 'quantity';
      }
      return node.exprType;
    }

    case 'bin': {
      const left = checkExpr(node.left, scope, fail);
      const right = checkExpr(node.right, scope, fail);
      const op = node.op;

      if (op === 'and' || op === 'or') {
        if (left !== 'bool' || right !== 'bool') {
          fail(`'${op}' requires boolean operands, got ${left} and ${right}`, node.line);
        }
        node.exprType = 'bool';
        return node.exprType;
      }

      if (op === '==' || op === '!=') {
        if (left !== right) fail(`cannot compare ${left} with ${right} using '${op}'`, node.line);
        node.exprType = 'bool';
        return node.exprType;
      }

      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (left !== right || !ORDERABLE.has(left)) {
          fail(`cannot order-compare ${left} with ${right}`, node.line);
        }
        node.exprType = 'bool';
        return node.exprType;
      }

      if (op === '+' || op === '-') {
        if (left === 'quantity' && right === 'quantity') node.exprType = 'quantity';
        else if (left === 'ratio' && right === 'ratio') node.exprType = 'ratio';
        else fail(`cannot apply '${op}' to ${left} and ${right}`, node.line);
        return node.exprType;
      }

      if (op === '*') {
        if (left === 'quantity' && right === 'quantity') node.exprType = 'quantity';
        else if (left === 'ratio' && right === 'ratio') node.exprType = 'ratio';
        else if ((left === 'ratio' && right === 'quantity') || (left === 'quantity' && right === 'ratio')) {
          node.exprType = 'ratio';
        } else fail(`cannot multiply ${left} by ${right}`, node.line);
        return node.exprType;
      }

      if (op === '/') {
        if (left === 'quantity' && right === 'quantity') node.exprType = 'ratio';
        else if (left === 'ratio' && right === 'quantity') node.exprType = 'ratio';
        else fail(`cannot divide ${left} by ${right}`, node.line);
        return node.exprType;
      }

      fail(`unknown operator '${op}'`, node.line);
      return null;
    }

    default:
      fail(`internal: unknown expression kind '${node.kind}'`, node.line ?? 0);
      return null;
  }
}
