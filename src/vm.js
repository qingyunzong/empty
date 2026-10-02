import { cidrContains } from './cidr.js';

export function run(program, consts, event) {
  const stack = [];
  for (const ins of program) {
    switch (ins[0]) {
      case 'LOAD': stack.push(event[ins[1]]); break;
      case 'PUSH': stack.push(consts[ins[1]]); break;
      case 'GT': case 'GE': case 'LT': case 'LE': case 'EQ': case 'NE': {
        const lit = stack.pop();
        const val = stack.pop();
        stack.push(compare(ins[0], val, lit, event));
        break;
      }
      case 'IN_CIDR': stack.push(cidrContains(consts[ins[1]], stack.pop())); break;
      case 'IN_RANGE': stack.push(inRange(stack.pop(), consts[ins[1]], event)); break;
      case 'IN_LIST': {
        const val = stack.pop();
        stack.push(typeof val === 'string' && consts[ins[1]].includes(val));
        break;
      }
      case 'MATCH_RE': {
        const val = stack.pop();
        stack.push(typeof val === 'string' && consts[ins[1]].test(val));
        break;
      }
      case 'AND': { const b = stack.pop(); const a = stack.pop(); stack.push(Boolean(a) && Boolean(b)); break; }
      case 'OR': { const b = stack.pop(); const a = stack.pop(); stack.push(Boolean(a) || Boolean(b)); break; }
      case 'NOT': stack.push(!stack.pop()); break;
      default: throw new Error(`bad opcode '${ins[0]}'`);
    }
  }
  return Boolean(stack.pop());
}

function compare(op, val, lit, event) {
  if (lit && lit.kind === 'moneyLit') {
    if (typeof val !== 'number') return false;
    if (lit.currency && event.currency && event.currency !== lit.currency) return false;
    return apply(op, val, lit.amount);
  }
  if (lit && lit.kind === 'countLit')
    return typeof val === 'number' && apply(op, val, lit.value);
  if (lit && lit.kind === 'stringLit')
    return typeof val === 'string' && apply(op, val, lit.value);
  return false;
}

function apply(op, a, b) {
  switch (op) {
    case 'GT': return a > b;
    case 'GE': return a >= b;
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    default: throw new Error(`bad cmp op '${op}'`);
  }
}

function inRange(val, range, event) {
  if (typeof val !== 'number') return false;
  const { lo, hi } = range;
  if (lo.kind === 'moneyLit') {
    if (lo.currency && event.currency && event.currency !== lo.currency) return false;
    return val >= lo.amount && val <= hi.amount;
  }
  return val >= lo.value && val <= hi.value;
}
