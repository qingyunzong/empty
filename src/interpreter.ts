import type { Node } from './ast.ts';
import { EvalError } from './errors.ts';
import { parse } from './parser.ts';

/**
 * Exact interpreter: identical semantics to the budgeted evaluator but with
 * no resource limits whatsoever. Used as the reference oracle in the
 * differential tests. Only feed it expressions whose values stay small.
 */
export function interpretAst(node: Node): bigint {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'neg':
      return -interpretAst(node.operand);
    case 'cond':
      return interpretAst(node.cond) !== 0n
        ? interpretAst(node.then)
        : interpretAst(node.otherwise);
    case 'bin': {
      const { op } = node;
      if (op === '&&') {
        if (interpretAst(node.left) === 0n) return 0n;
        return interpretAst(node.right) !== 0n ? 1n : 0n;
      }
      if (op === '||') {
        if (interpretAst(node.left) !== 0n) return 1n;
        return interpretAst(node.right) !== 0n ? 1n : 0n;
      }
      const left = interpretAst(node.left);
      const right = interpretAst(node.right);
      switch (op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '^': {
          if (right < 0n) {
            throw new EvalError('negative exponent is not an integer operation', node.range);
          }
          return left ** right;
        }
        case '==':
          return left === right ? 1n : 0n;
        case '!=':
          return left !== right ? 1n : 0n;
        case '<':
          return left < right ? 1n : 0n;
        case '<=':
          return left <= right ? 1n : 0n;
        case '>':
          return left > right ? 1n : 0n;
        case '>=':
          return left >= right ? 1n : 0n;
      }
    }
  }
}

export function evaluateExact(source: string): bigint {
  return interpretAst(parse(source));
}
