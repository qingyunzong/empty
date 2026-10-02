'use strict';

const { QueryTypeError, RegexCompileError } = require('./errors');

const FIELD_TYPES = new Set(['string', 'number', 'date', 'boolean']);
const EQUALITY_OPS = new Set(['=', '==', '!=']);
const ORDER_OPS = new Set(['=', '==', '!=', '<', '<=', '>', '>=']);

function validateSchema(schema) {
  if (!schema || typeof schema !== 'object' || typeof schema.fields !== 'object') {
    throw new QueryTypeError('Schema must be an object with a "fields" map');
  }
  for (const [name, type] of Object.entries(schema.fields)) {
    if (!FIELD_TYPES.has(type)) {
      throw new QueryTypeError(`Field '${name}' has unsupported type '${type}'`);
    }
  }
}

function compileRegex(source, flags) {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new RegexCompileError(`Invalid regex /${source}/${flags}: ${err.message}`);
  }
}

function parseNumberLiteral(raw, field) {
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    throw new QueryTypeError(`Field '${field}' is number; '${raw}' is not a numeric literal`);
  }
  return Number(raw);
}

function parseDateLiteral(raw, field) {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new QueryTypeError(`Field '${field}' is date; '${raw}' is not a valid date literal`);
  }
  return ms;
}

function parseBooleanLiteral(raw, field) {
  if (!/^(true|false)$/i.test(raw)) {
    throw new QueryTypeError(`Field '${field}' is boolean; '${raw}' is not true/false`);
  }
  return raw.toLowerCase() === 'true';
}

// Statically checks the AST against the schema and annotates match/cmp
// nodes with `resolved` = { type, value } where value is the typed
// literal (number, epoch ms for dates, boolean, or string).
function typecheck(node, schema) {
  validateSchema(schema);
  const { fields } = schema;

  const fieldType = (name) => {
    const type = fields[name];
    if (type === undefined) {
      throw new QueryTypeError(`Unknown field '${name}'`);
    }
    return type;
  };

  const walk = (n) => {
    switch (n.type) {
      case 'and':
      case 'or':
        n.children.forEach(walk);
        return;
      case 'not':
        walk(n.child);
        return;
      case 'text': {
        if (n.value.kind === 'regex') {
          compileRegex(n.value.value, n.value.flags || '');
        }
        return;
      }
      case 'match': {
        const type = fieldType(n.field);
        const v = n.value;
        if (type === 'string') {
          if (v.kind === 'regex') {
            compileRegex(v.value, v.flags || '');
          }
          n.resolved = { type: 'string', value: v.value };
        } else if (type === 'number') {
          if (v.kind !== 'word') {
            throw new QueryTypeError(`Field '${n.field}' is number; expected a numeric literal`);
          }
          n.resolved = { type: 'number', value: parseNumberLiteral(v.value, n.field) };
        } else if (type === 'date') {
          if (v.kind === 'regex') {
            throw new QueryTypeError(`Field '${n.field}' is date; regex predicates require a string field`);
          }
          n.resolved = { type: 'date', value: parseDateLiteral(v.value, n.field) };
        } else if (type === 'boolean') {
          if (v.kind !== 'word') {
            throw new QueryTypeError(`Field '${n.field}' is boolean; expected true or false`);
          }
          n.resolved = { type: 'boolean', value: parseBooleanLiteral(v.value, n.field) };
        }
        return;
      }
      case 'cmp': {
        const type = fieldType(n.field);
        const v = n.value;
        if (type === 'string') {
          if (!EQUALITY_OPS.has(n.op)) {
            throw new QueryTypeError(
              `Operator '${n.op}' cannot be applied to string field '${n.field}'; ` +
              'ordering comparisons require a number or date field'
            );
          }
          if (v.kind === 'regex') {
            throw new QueryTypeError(`Use 'field:/regex/' for regex predicates on string field '${n.field}'`);
          }
          n.resolved = { type: 'string', value: v.value };
        } else if (type === 'number') {
          if (!ORDER_OPS.has(n.op)) {
            throw new QueryTypeError(`Operator '${n.op}' cannot be applied to number field '${n.field}'`);
          }
          if (v.kind !== 'word') {
            throw new QueryTypeError(`Field '${n.field}' is number; expected a numeric literal`);
          }
          n.resolved = { type: 'number', value: parseNumberLiteral(v.value, n.field) };
        } else if (type === 'date') {
          if (!ORDER_OPS.has(n.op)) {
            throw new QueryTypeError(`Operator '${n.op}' cannot be applied to date field '${n.field}'`);
          }
          if (v.kind === 'regex') {
            throw new QueryTypeError(`Field '${n.field}' is date; regex predicates require a string field`);
          }
          n.resolved = { type: 'date', value: parseDateLiteral(v.value, n.field) };
        } else if (type === 'boolean') {
          if (!EQUALITY_OPS.has(n.op)) {
            throw new QueryTypeError(`Operator '${n.op}' cannot be applied to boolean field '${n.field}'`);
          }
          if (v.kind !== 'word') {
            throw new QueryTypeError(`Field '${n.field}' is boolean; expected true or false`);
          }
          n.resolved = { type: 'boolean', value: parseBooleanLiteral(v.value, n.field) };
        }
        return;
      }
      default:
        throw new QueryTypeError(`Unknown AST node type '${n.type}'`);
    }
  };

  walk(node);
  return node;
}

module.exports = { typecheck, validateSchema };
