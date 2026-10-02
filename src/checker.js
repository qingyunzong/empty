'use strict';

const { QueryError } = require('./errors');

const FIELD_TYPES = {
  ts: 'time',
  device: 'string',
  code: 'string',
  value: 'number',
};

function lookupRef(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return scopes[i].get(name).type;
  }
  if (FIELD_TYPES[name]) return FIELD_TYPES[name];
  throw new QueryError(`unknown field or variable '${name}'`);
}

function checkExpr(node, scopes) {
  switch (node.type) {
    case 'lit':
      return node.litType;
    case 'ref':
      return lookupRef(node.name, scopes);
    case 'not': {
      const t = checkExpr(node.operand, scopes);
      if (t !== 'boolean') throw new QueryError(`'not' requires a boolean operand, got ${t}`);
      return 'boolean';
    }
    case 'logic': {
      const lt = checkExpr(node.left, scopes);
      const rt = checkExpr(node.right, scopes);
      if (lt !== 'boolean' || rt !== 'boolean') {
        throw new QueryError(`'${node.op}' requires boolean operands, got ${lt} and ${rt}`);
      }
      return 'boolean';
    }
    case 'cmp': {
      const lt = checkExpr(node.left, scopes);
      const rt = checkExpr(node.right, scopes);
      if (node.op === 'matches') {
        if (lt !== 'string') {
          throw new QueryError(`'matches' requires a string left operand, got ${lt}`);
        }
        if (node.right.type !== 'lit' || node.right.litType !== 'string') {
          throw new QueryError(`'matches' requires a string pattern literal on the right`);
        }
        return 'boolean';
      }
      if (node.op === 'eq' || node.op === 'ne') {
        if (lt !== rt) throw new QueryError(`cannot compare ${lt} with ${rt}`);
        return 'boolean';
      }
      const ordered = (lt === 'number' && rt === 'number') || (lt === 'time' && rt === 'time');
      if (!ordered) throw new QueryError(`cannot order-compare ${lt} with ${rt}`);
      return 'boolean';
    }
    default:
      throw new QueryError(`internal: unknown node type '${node.type}'`);
  }
}

function check(program) {
  const scopes = [new Map()];
  const slotNames = [];
  for (const decl of program.lets) {
    const t = checkExpr(decl.expr, scopes);
    scopes[scopes.length - 1].set(decl.name, { type: t, slot: slotNames.length });
    slotNames.push(decl.name);
  }
  if (program.where) {
    const t = checkExpr(program.where, scopes);
    if (t !== 'boolean') {
      throw new QueryError(`where expression must be boolean, got ${t}`);
    }
  }
  if (program.select) {
    for (const agg of program.select) {
      if (agg.fn === 'count') continue;
      const ft = FIELD_TYPES[agg.field];
      if (!ft) throw new QueryError(`unknown field '${agg.field}' in ${agg.fn}()`);
      if ((agg.fn === 'sum' || agg.fn === 'avg') && ft !== 'number') {
        throw new QueryError(`${agg.fn}() requires a numeric field, got ${ft}`);
      }
      if ((agg.fn === 'min' || agg.fn === 'max') && ft !== 'number' && ft !== 'time') {
        throw new QueryError(`${agg.fn}() requires a numeric or time field, got ${ft}`);
      }
    }
  }
  return { slotNames };
}

module.exports = { check, FIELD_TYPES };
