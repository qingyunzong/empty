'use strict';

// Compiles a normalized, type-checked AST into a flat postfix bytecode
// program for the stack VM in vm.js.
//
// Instruction set:
//   { op: 'text', value }                 full-text substring over string fields
//   { op: 'regex', source, flags }        full-text regex over string fields
//   { op: 'field_text', field, value }    substring within one string field
//   { op: 'field_regex', field, source, flags }
//   { op: 'field_eq', field, value }      typed equality (number/date/boolean)
//   { op: 'field_strcmp', field, cmp, value }   string = / !=
//   { op: 'cmp', field, cmp, value }      number/date comparison
//   { op: 'not' } | { op: 'and' } | { op: 'or' }
function compile(node, out = []) {
  switch (node.type) {
    case 'and':
    case 'or': {
      for (const child of node.children) {
        compile(child, out);
      }
      for (let k = 0; k < node.children.length - 1; k += 1) {
        out.push({ op: node.type });
      }
      return out;
    }
    case 'not':
      compile(node.child, out);
      out.push({ op: 'not' });
      return out;
    case 'text': {
      const v = node.value;
      if (v.kind === 'regex') {
        out.push({ op: 'regex', source: v.value, flags: v.flags || '' });
      } else {
        out.push({ op: 'text', value: v.value });
      }
      return out;
    }
    case 'match': {
      const resolved = node.resolved;
      const v = node.value;
      if (resolved.type === 'string') {
        if (v.kind === 'regex') {
          out.push({ op: 'field_regex', field: node.field, source: v.value, flags: v.flags || '' });
        } else {
          out.push({ op: 'field_text', field: node.field, value: v.value });
        }
      } else {
        out.push({ op: 'field_eq', field: node.field, value: resolved.value });
      }
      return out;
    }
    case 'cmp': {
      const resolved = node.resolved;
      const cmp = node.op === '==' ? '=' : node.op;
      if (resolved.type === 'string') {
        out.push({ op: 'field_strcmp', field: node.field, cmp, value: resolved.value });
      } else {
        out.push({ op: 'cmp', field: node.field, cmp, value: resolved.value });
      }
      return out;
    }
    default:
      throw new Error(`Cannot compile node type ${node.type}`);
  }
}

module.exports = { compile };
