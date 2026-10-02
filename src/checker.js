import { FormulaError } from './errors.js';
import {
  DIMENSIONLESS, equalDim, mulDim, divDim, powDim, formatDim,
} from './dimensions.js';

// Unary functions declare their parameter dimension and result dimension.
// param '*' accepts any dimension; result 'same' mirrors the argument,
// result 'sqrt' halves the exponent vector.
export const FUNCTIONS = {
  sin: { param: '1', result: '1' },
  cos: { param: '1', result: '1' },
  tan: { param: '1', result: '1' },
  asin: { param: '1', result: '1' },
  acos: { param: '1', result: '1' },
  atan: { param: '1', result: '1' },
  exp: { param: '1', result: '1' },
  ln: { param: '1', result: '1' },
  log10: { param: '1', result: '1' },
  abs: { param: '*', result: 'same' },
  sqrt: { param: '*', result: 'sqrt' },
};

const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!=']);

function mismatch(node, leftDim, rightDim, op) {
  return new FormulaError(
    'DIM_MISMATCH',
    `operator "${op}" requires equal dimensions, got ${formatDim(leftDim)} and ${formatDim(rightDim)}`,
    {
      position: { start: node.start, end: node.end },
      left: formatDim(leftDim),
      right: formatDim(rightDim),
      operator: op,
    },
  );
}

export function check(node, env) {
  switch (node.type) {
    case 'assign': {
      const rd = check(node.right, env);
      const declared = env[node.target.name];
      if (declared && !equalDim(declared, rd)) {
        throw mismatch(node, declared, rd, '=');
      }
      node.target.dim = rd;
      node.dim = rd;
      return rd;
    }
    case 'num':
      node.dim = DIMENSIONLESS;
      return node.dim;
    case 'var': {
      const d = env[node.name];
      if (!d) {
        throw new FormulaError('UNKNOWN_VARIABLE', `unknown variable "${node.name}"`, {
          position: { start: node.start, end: node.end },
          variable: node.name,
        });
      }
      node.dim = d;
      return d;
    }
    case 'neg':
      node.dim = check(node.arg, env);
      return node.dim;
    case 'bin': {
      const ld = check(node.left, env);
      const rd = check(node.right, env);
      if (node.op === '+' || node.op === '-') {
        if (!equalDim(ld, rd)) throw mismatch(node, ld, rd, node.op);
        node.dim = ld;
      } else if (COMPARISONS.has(node.op)) {
        if (!equalDim(ld, rd)) throw mismatch(node, ld, rd, node.op);
        node.dim = DIMENSIONLESS;
      } else if (node.op === '*') {
        node.dim = mulDim(ld, rd);
      } else if (node.op === '/') {
        node.dim = divDim(ld, rd);
      } else if (node.op === '^') {
        if (node.right.type !== 'num') {
          throw new FormulaError('DIM_POW', 'exponent must be a numeric literal', {
            position: { start: node.right.start, end: node.right.end },
          });
        }
        node.dim = powDim(ld, node.right.value);
      }
      return node.dim;
    }
    case 'call': {
      const spec = FUNCTIONS[node.fn];
      if (!spec) {
        throw new FormulaError('UNKNOWN_FUNCTION', `unknown function "${node.fn}"`, {
          position: { start: node.start, end: node.end },
          function: node.fn,
          known: Object.keys(FUNCTIONS),
        });
      }
      const argDim = check(node.arg, env);
      if (spec.param === '1' && !equalDim(argDim, DIMENSIONLESS)) {
        throw new FormulaError(
          'DIM_FUNCTION_ARG',
          `${node.fn}() expects a dimensionless argument, got ${formatDim(argDim)}`,
          {
            position: { start: node.arg.start, end: node.arg.end },
            function: node.fn,
            expected: '1',
            actual: formatDim(argDim),
          },
        );
      }
      if (spec.result === '1') node.dim = DIMENSIONLESS;
      else if (spec.result === 'same') node.dim = argDim;
      else if (spec.result === 'sqrt') {
        const d = powDim(argDim, 0.5);
        if (![d.m, d.s, d.kg].every(Number.isInteger)) {
          throw new FormulaError(
            'DIM_FUNCTION_ARG',
            `sqrt() requires even exponents, got ${formatDim(argDim)}`,
            {
              position: { start: node.arg.start, end: node.arg.end },
              function: node.fn,
              actual: formatDim(argDim),
            },
          );
        }
        node.dim = d;
      }
      return node.dim;
    }
    default:
      throw new FormulaError('INTERNAL', `unknown node type "${node.type}"`);
  }
}

// Preorder enumeration of every subexpression with its inferred dimension.
export function subexpressionTable(ast, source) {
  const rows = [];
  (function walk(node) {
    rows.push({ expr: source.slice(node.start, node.end), dim: formatDim(node.dim) });
    if (node.type === 'bin') { walk(node.left); walk(node.right); }
    else if (node.type === 'neg' || node.type === 'call') walk(node.arg);
    else if (node.type === 'assign') { walk(node.target); walk(node.right); }
  })(ast);
  return rows;
}
