import { E } from './errors.js';
import { FIELD_TYPES } from './parser.js';

function fieldType(name) {
  const t = FIELD_TYPES[name];
  if (!t) throw E('E_TYPE', `unknown event field '${name}'`);
  return t;
}

const LIT_NAME = {
  moneyLit: 'money', countLit: 'count', floatLit: 'count', stringLit: 'string',
};

export function typecheckExpr(node) {
  switch (node.kind) {
    case 'and':
    case 'or':
      typecheckExpr(node.left);
      typecheckExpr(node.right);
      return;
    case 'not':
      typecheckExpr(node.expr);
      return;
    case 'cmp': {
      const ft = fieldType(node.field);
      const lk = node.value.kind;
      if (lk === 'floatLit')
        throw E('E_TYPE', `non-integer literal ${node.value.value} is not a valid count`);
      if (ft === 'money' && lk !== 'moneyLit')
        throw E('E_TYPE', `field '${node.field}' is money; cannot compare with a ${LIT_NAME[lk]} literal`);
      if (ft === 'count' && lk !== 'countLit')
        throw E('E_TYPE', `field '${node.field}' is count; cannot compare with a ${LIT_NAME[lk]} literal`);
      if (ft === 'string') {
        if (lk !== 'stringLit')
          throw E('E_TYPE', `field '${node.field}' is string; cannot compare with a ${LIT_NAME[lk]} literal`);
        if (node.op !== '==' && node.op !== '!=')
          throw E('E_TYPE', `string field '${node.field}' only supports == and !=`);
      }
      if (ft === 'cidr')
        throw E('E_TYPE', `cidr field '${node.field}' only supports 'in <cidr>'`);
      return;
    }
    case 'inCidr':
      if (fieldType(node.field) !== 'cidr')
        throw E('E_TYPE', `'in <cidr>' requires a cidr field, got '${node.field}'`);
      return;
    case 'inRange': {
      const ft = fieldType(node.field);
      if (node.lo.kind !== node.hi.kind)
        throw E('E_TYPE', 'range bounds must have the same type');
      if (ft !== 'money' && ft !== 'count')
        throw E('E_TYPE', `ranges are not supported for ${ft} field '${node.field}'`);
      if (ft === 'money' && node.lo.kind !== 'moneyLit')
        throw E('E_TYPE', `field '${node.field}' is money; range bounds must be money literals`);
      if (ft === 'count' && node.lo.kind !== 'countLit')
        throw E('E_TYPE', `field '${node.field}' is count; range bounds must be integer literals`);
      if (node.lo.kind === 'moneyLit') {
        if (node.lo.currency !== node.hi.currency)
          throw E('E_TYPE', 'range bounds use different currencies');
        if (node.lo.amount > node.hi.amount) throw E('E_TYPE', 'range lower bound exceeds upper bound');
      } else if (node.lo.value > node.hi.value) {
        throw E('E_TYPE', 'range lower bound exceeds upper bound');
      }
      return;
    }
    case 'inList':
      if (fieldType(node.field) !== 'string')
        throw E('E_TYPE', `list membership requires a string field, got '${node.field}'`);
      return;
    case 'matchRegex':
      if (fieldType(node.field) !== 'string')
        throw E('E_TYPE', `regex whitelist requires a string field, got '${node.field}'`);
      return;
    default:
      throw E('E_TYPE', `expression node '${node.kind}' is not a boolean condition`);
  }
}
