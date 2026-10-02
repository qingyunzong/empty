import { RuntimeFault } from './errors.js';
import { gcd } from './parser.js';

export const VERDICT_NAMES = ['ACCEPT', 'REJECT', 'CONTINUE'];

const LEVELS = { minor: 1, major: 2, critical: 3 };

function normRatio(n, d) {
  if (d === 0) throw new RuntimeFault('division by zero during rule evaluation');
  if (d < 0) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function isRatio(v) {
  return typeof v === 'object' && v !== null && 'n' in v && 'd' in v;
}

function cmpValues(a, b) {
  if (isRatio(a) && isRatio(b)) {
    const left = a.n * b.d;
    const right = b.n * a.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  throw new RuntimeFault('internal: incomparable values on the VM stack');
}

function eqValues(a, b) {
  if (isRatio(a) && isRatio(b)) return a.n === b.n && a.d === b.d;
  return a === b;
}

function materialize(entry) {
  switch (entry.kind) {
    case 'quantity':
    case 'level':
    case 'bool':
      return entry.value;
    case 'date':
    case 'batch':
      return entry.value;
    case 'ratio':
      return { n: entry.value.n, d: entry.value.d };
    default:
      throw new RuntimeFault(`internal: unknown constant kind '${entry.kind}'`);
  }
}

function convertParam(param, context) {
  if (!(param.name in context)) {
    throw new RuntimeFault(`evaluation context is missing parameter '${param.name}'`);
  }
  const value = context[param.name];
  switch (param.type) {
    case 'quantity':
      if (!Number.isInteger(value)) {
        throw new RuntimeFault(`parameter '${param.name}' must be an integer, got ${JSON.stringify(value)}`);
      }
      return value;
    case 'level':
      if (typeof value === 'string' && value in LEVELS) return LEVELS[value];
      if (Number.isInteger(value) && value >= 1 && value <= 3) return value;
      throw new RuntimeFault(`parameter '${param.name}' must be a defect level (minor|major|critical)`);
    case 'ratio':
      if (isRatio(value)) return { n: value.n, d: value.d };
      throw new RuntimeFault(`parameter '${param.name}' must be a ratio`);
    case 'date':
    case 'batch':
      if (typeof value === 'string') return value;
      throw new RuntimeFault(`parameter '${param.name}' must be a string`);
    default:
      throw new RuntimeFault(`internal: unknown param type '${param.type}'`);
  }
}

// Runs a compiled program against a context object and returns
// 'ACCEPT' | 'REJECT' | 'CONTINUE'. CONTINUE is a legal pending verdict:
// it is returned when no clause fires, never as an error sentinel.
export function run(program, context = {}) {
  const locals = new Array(program.slotCount).fill(undefined);
  for (const param of program.params) {
    locals[param.slot] = convertParam(param, context);
  }

  const stack = [];
  const pop2 = () => {
    const b = stack.pop();
    const a = stack.pop();
    return [a, b];
  };

  let pc = 0;
  while (pc < program.code.length) {
    const { op, arg } = program.code[pc];
    switch (op) {
      case 'PUSH':
        stack.push(materialize(program.consts[arg]));
        break;
      case 'LOAD':
        stack.push(locals[arg]);
        break;
      case 'STORE':
        locals[arg] = stack.pop();
        break;
      case 'NEG':
        stack.push(-stack.pop());
        break;
      case 'NOT':
        stack.push(!stack.pop());
        break;
      case 'ADD': {
        const [a, b] = pop2();
        if (isRatio(a) && isRatio(b)) stack.push(normRatio(a.n * b.d + b.n * a.d, a.d * b.d));
        else stack.push(a + b);
        break;
      }
      case 'SUB': {
        const [a, b] = pop2();
        if (isRatio(a) && isRatio(b)) stack.push(normRatio(a.n * b.d - b.n * a.d, a.d * b.d));
        else stack.push(a - b);
        break;
      }
      case 'MUL': {
        const [a, b] = pop2();
        if (isRatio(a) && isRatio(b)) stack.push(normRatio(a.n * b.n, a.d * b.d));
        else if (isRatio(a) && typeof b === 'number') stack.push(normRatio(a.n * b, a.d));
        else if (typeof a === 'number' && isRatio(b)) stack.push(normRatio(a * b.n, b.d));
        else stack.push(a * b);
        break;
      }
      case 'DIV': {
        const [a, b] = pop2();
        if (typeof a === 'number' && typeof b === 'number') stack.push(normRatio(a, b));
        else if (isRatio(a) && typeof b === 'number') stack.push(normRatio(a.n, a.d * b));
        else throw new RuntimeFault('internal: bad operands for DIV');
        break;
      }
      case 'LT': { const [a, b] = pop2(); stack.push(cmpValues(a, b) < 0); break; }
      case 'LE': { const [a, b] = pop2(); stack.push(cmpValues(a, b) <= 0); break; }
      case 'GT': { const [a, b] = pop2(); stack.push(cmpValues(a, b) > 0); break; }
      case 'GE': { const [a, b] = pop2(); stack.push(cmpValues(a, b) >= 0); break; }
      case 'EQ': { const [a, b] = pop2(); stack.push(eqValues(a, b)); break; }
      case 'NE': { const [a, b] = pop2(); stack.push(!eqValues(a, b)); break; }
      case 'JMP':
        pc = arg;
        continue;
      case 'JMP_IF_FALSE':
        if (!stack.pop()) { pc = arg; continue; }
        break;
      case 'JMP_IF_TRUE':
        if (stack.pop()) { pc = arg; continue; }
        break;
      case 'VERDICT':
        return VERDICT_NAMES[arg];
      case 'HALT':
        return 'CONTINUE';
      default:
        throw new RuntimeFault(`internal: unknown opcode '${op}'`);
    }
    pc += 1;
  }
  return 'CONTINUE';
}
