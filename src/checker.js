import { DslTypeError } from './lexer.js';

export const FIELD_TYPES = {
  ts: 'time',
  device: 'string',
  code: 'string',
  value: 'number',
};

function typeOf(node, lets) {
  switch (node.type) {
    case 'num': return 'number';
    case 'time': return 'time';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'field': {
      const t = FIELD_TYPES[node.name];
      if (t === undefined) {
        throw new DslTypeError(`unknown field '${node.name}' (known fields: ts, device, code, value)`);
      }
      return t;
    }
    case 'ref': return 'bool'; // let-bound names are boolean subqueries
    case 'not': {
      requireBool(typeOf(node.expr, lets), 'not');
      return 'bool';
    }
    case 'and':
    case 'or': {
      requireBool(typeOf(node.left, lets), node.type);
      requireBool(typeOf(node.right, lets), node.type);
      return 'bool';
    }
    case 'cmp': {
      const lt = typeOf(node.left, lets);
      const rt = typeOf(node.right, lets);
      checkComparison(node.op, lt, rt);
      return 'bool';
    }
    default:
      throw new DslTypeError(`cannot type node of type ${node.type}`);
  }
}

function requireBool(t, context) {
  if (t !== 'bool') {
    throw new DslTypeError(`'${context}' expects boolean operands, got ${t}`);
  }
}

function checkComparison(op, lt, rt) {
  if (op === '=~' || op === '!~') {
    if (lt !== 'string' || rt !== 'string') {
      throw new DslTypeError(`'${op}' (pattern match) requires string operands, got ${lt} and ${rt}`);
    }
    return;
  }
  if (lt !== rt) {
    throw new DslTypeError(`cannot compare ${lt} with ${rt} using '${op}'`);
  }
  if (op === '==' || op === '!=') return;
  if (lt !== 'number' && lt !== 'time') {
    throw new DslTypeError(`'${op}' requires number or time operands, got ${lt}`);
  }
}

export function check(program) {
  // let bodies must be boolean subqueries; check in declaration order so a
  // body may only reference earlier lets (lexical scope, enforced by parser).
  for (const decl of program.lets) {
    requireBool(typeOf(decl.expr, program.lets), `let ${decl.name}`);
  }
  requireBool(typeOf(program.filter, program.lets), 'query filter');
  if (program.aggs) {
    for (const agg of program.aggs) {
      if (agg.fn === 'count') continue;
      const t = FIELD_TYPES[agg.field];
      if (t === undefined) {
        throw new DslTypeError(`unknown field '${agg.field}' in ${agg.fn}()`);
      }
      if (t !== 'number') {
        throw new DslTypeError(`${agg.fn}() requires a number field, got ${agg.field} (${t})`);
      }
    }
    if (program.groupBy !== null) {
      const t = FIELD_TYPES[program.groupBy];
      if (t === undefined) {
        throw new DslTypeError(`unknown field '${program.groupBy}' in by clause`);
      }
      if (t !== 'string') {
        throw new DslTypeError(`by clause requires a string field, got ${program.groupBy} (${t})`);
      }
    }
  }
  return program;
}
