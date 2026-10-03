'use strict';

const { QuerySchemaError, QueryTypeError, QueryRegexError } = require('./errors');
const { stringFields } = require('./schema');

const RANGE_OPS = new Set(['<', '<=', '>', '>=']);
const EQUALITY_OPS = new Set(['=', '!=']);

function compileRegex(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new QueryRegexError(`invalid regex /${pattern}/${flags}: ${err.message}`);
  }
}

function coerceLiteral(raw, fieldType, fieldName) {
  switch (fieldType) {
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw new QueryTypeError(`value '${raw}' is not a valid number for field '${fieldName}'`);
      }
      return num;
    }
    case 'date': {
      const time = Date.parse(raw);
      if (Number.isNaN(time)) {
        throw new QueryTypeError(`value '${raw}' is not a valid date for field '${fieldName}'`);
      }
      return time;
    }
    case 'boolean': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new QueryTypeError(`value '${raw}' is not a valid boolean for field '${fieldName}'`);
    }
    case 'string':
      return raw;
    default:
      throw new QueryTypeError(`unknown field type '${fieldType}'`);
  }
}

function checkNode(node, schema) {
  switch (node.type) {
    case 'binary':
      checkNode(node.left, schema);
      checkNode(node.right, schema);
      return;
    case 'not':
      checkNode(node.operand, schema);
      return;
    case 'fulltext': {
      if (stringFields(schema).length === 0) {
        throw new QueryTypeError('full-text predicate requires at least one string field in schema');
      }
      if (node.match === 'regex') {
        compileRegex(node.value, node.flags || '');
      }
      return;
    }
    case 'field': {
      const def = schema.fields[node.field];
      if (!def) {
        throw new QuerySchemaError(`unknown field '${node.field}'`);
      }
      if (def.type !== 'string') {
        throw new QueryTypeError(
          `field '${node.field}' has type '${def.type}'; string predicate requires a string field`
        );
      }
      if (node.match === 'regex') {
        compileRegex(node.value, node.flags || '');
      }
      return;
    }
    case 'compare': {
      const def = schema.fields[node.field];
      if (!def) {
        throw new QuerySchemaError(`unknown field '${node.field}'`);
      }
      if (RANGE_OPS.has(node.op) && def.type !== 'number' && def.type !== 'date') {
        throw new QueryTypeError(
          `operator '${node.op}' requires a number or date field, but '${node.field}' has type '${def.type}'`
        );
      }
      if (!RANGE_OPS.has(node.op) && !EQUALITY_OPS.has(node.op)) {
        throw new QueryTypeError(`unsupported operator '${node.op}'`);
      }
      node.value = coerceLiteral(node.value, def.type, node.field);
      return;
    }
    default:
      throw new QueryTypeError(`unknown AST node type '${node.type}'`);
  }
}

function check(ast, schema) {
  checkNode(ast, schema);
  return ast;
}

module.exports = { check, compileRegex, coerceLiteral };
