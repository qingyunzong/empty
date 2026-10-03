'use strict';

const units = require('./units');
const { FormulaError, dimensionMismatch, unknownVariable } = require('./errors');

// Unary function declarations: parameter dimension requirement and result rule.
// param: 'dimensionless' | 'any'; result: 'dimensionless' | 'same' | 'sqrt'.
const FUNCTIONS = {
  sin: { param: 'dimensionless', result: 'dimensionless' },
  cos: { param: 'dimensionless', result: 'dimensionless' },
  tan: { param: 'dimensionless', result: 'dimensionless' },
  exp: { param: 'dimensionless', result: 'dimensionless' },
  ln: { param: 'dimensionless', result: 'dimensionless' },
  log: { param: 'dimensionless', result: 'dimensionless' },
  abs: { param: 'any', result: 'same' },
  sqrt: { param: 'any', result: 'sqrt' },
};

const COMPARISONS = new Set(['<', '>', '<=', '>=', '==', '!=']);

function isDimensionless(vec) {
  return units.equal(vec, units.zero());
}

// Statically infer the dimension of every node. Returns { dim, table } where
// table maps variable names to dimension vectors (base env plus assignment).
function check(ast, env) {
  const table = new Map(env); // name -> vector

  function infer(node) {
    switch (node.type) {
      case 'Number':
        node.dim = units.zero();
        return node.dim;
      case 'Var': {
        const dim = table.get(node.name);
        if (!dim) throw unknownVariable(node.name, node.start);
        node.dim = dim;
        return dim;
      }
      case 'Unary': {
        const d = infer(node.arg);
        node.dim = d;
        return d;
      }
      case 'Binary': {
        const left = infer(node.left);
        const right = infer(node.right);
        if (node.op === '+' || node.op === '-' || COMPARISONS.has(node.op)) {
          if (!units.equal(left, right)) {
            const l = units.formatDimension(left);
            const r = units.formatDimension(right);
            throw dimensionMismatch(
              `operator "${node.op}" requires equal dimensions, got ${l} and ${r} at column ${node.opStart + 1}`,
              { position: node.opStart, column: node.opStart + 1, left: l, right: r }
            );
          }
          node.dim = COMPARISONS.has(node.op) ? units.zero() : left;
          return node.dim;
        }
        if (node.op === '*') {
          node.dim = units.add(left, right);
          return node.dim;
        }
        if (node.op === '/') {
          node.dim = units.sub(left, right);
          return node.dim;
        }
        throw new FormulaError('PARSE_ERROR', `unknown operator "${node.op}"`, { position: node.opStart });
      }
      case 'Call': {
        const decl = FUNCTIONS[node.name];
        if (!decl) {
          const known = Object.keys(FUNCTIONS).join(', ');
          throw new FormulaError(
            'UNKNOWN_FUNCTION',
            `unknown function "${node.name}" at column ${node.start + 1} (known: ${known})`,
            { position: node.start, column: node.start + 1 }
          );
        }
        if (node.args.length !== 1) {
          throw new FormulaError(
            'ARITY_ERROR',
            `function "${node.name}" takes exactly 1 argument, got ${node.args.length}`,
            { position: node.start, column: node.start + 1 }
          );
        }
        const argDim = infer(node.args[0]);
        if (decl.param === 'dimensionless' && !isDimensionless(argDim)) {
          throw dimensionMismatch(
            `function "${node.name}" requires a dimensionless argument, got ${units.formatDimension(argDim)} at column ${node.start + 1}`,
            { position: node.start, column: node.start + 1, expected: '1', actual: units.formatDimension(argDim) }
          );
        }
        if (decl.result === 'dimensionless') node.dim = units.zero();
        else if (decl.result === 'same') node.dim = argDim;
        else if (decl.result === 'sqrt') node.dim = units.scale(argDim, 0.5);
        return node.dim;
      }
      case 'Assign': {
        const d = infer(node.value);
        table.set(node.target, d);
        node.dim = d;
        return d;
      }
      default:
        throw new FormulaError('INTERNAL', `unknown node type "${node.type}"`);
    }
  }

  const dim = infer(ast);
  return { dim, table };
}

// Enumerate every subexpression's inferred dimension (post-order, deduped by
// source span) for tabular comparison.
function enumerateDimensions(ast, src) {
  const rows = [];
  const seen = new Set();
  (function walk(node) {
    for (const key of ['left', 'right', 'arg', 'value']) {
      if (node[key] && typeof node[key] === 'object' && node[key].type) walk(node[key]);
    }
    if (node.args) for (const a of node.args) walk(a);
    const key = `${node.start}:${node.end}`;
    if (!seen.has(key) && node.dim) {
      seen.add(key);
      rows.push({
        expression: src.slice(node.start, node.end),
        dimension: units.formatDimension(node.dim),
      });
    }
  })(ast);
  return rows;
}

module.exports = { check, enumerateDimensions, FUNCTIONS };
