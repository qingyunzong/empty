'use strict';

const { compileRegex } = require('./checker');
const { stringFields } = require('./schema');

const COMPARE_OPS = {
  '=': 'EQ',
  '!=': 'NE',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
};

function emitMatch(out, node) {
  if (node.match === 'regex') {
    out.push({ op: 'PUSH_REGEX', source: node.value, flags: node.flags || '' });
    out.push({ op: 'REGEX_TEST' });
  } else {
    out.push({ op: 'PUSH_CONST', value: node.value });
    out.push({ op: 'CONTAINS_CI' });
  }
}

function compileNode(node, schema, out) {
  switch (node.type) {
    case 'binary':
      compileNode(node.left, schema, out);
      compileNode(node.right, schema, out);
      out.push({ op: node.op === 'and' ? 'AND' : 'OR' });
      break;
    case 'not':
      compileNode(node.operand, schema, out);
      out.push({ op: 'NOT' });
      break;
    case 'fulltext': {
      const fields = stringFields(schema);
      for (const field of fields) {
        out.push({ op: 'LOAD_FIELD', field });
        emitMatch(out, node);
      }
      out.push({ op: 'OR_N', count: fields.length });
      break;
    }
    case 'field':
      out.push({ op: 'LOAD_FIELD', field: node.field });
      emitMatch(out, node);
      break;
    case 'compare':
      out.push({ op: 'LOAD_FIELD', field: node.field });
      out.push({ op: 'PUSH_CONST', value: node.value });
      out.push({ op: COMPARE_OPS[node.op] });
      break;
    default:
      throw new Error(`cannot compile node type '${node.type}'`);
  }
}

function compile(ast, schema) {
  const out = [];
  compileNode(ast, schema, out);
  return out;
}

function materializeRegexes(bytecode) {
  return bytecode.map((instr) => {
    if (instr.op === 'PUSH_REGEX') {
      return { op: 'PUSH_CONST', value: compileRegex(instr.source, instr.flags) };
    }
    return instr;
  });
}

module.exports = { compile, materializeRegexes };
