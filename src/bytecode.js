import { TypeCheckError } from './typecheck.js';

export const UNIT_MINUTES = { m: 1, h: 60, d: 1440 };

export function durToMinutes(v, unit) {
  return v * UNIT_MINUTES[unit];
}

export function parseInstant(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (!m) throw new TypeCheckError(`invalid instant '@${str}', expected @YYYY-MM-DDTHH:MM`);
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  if (Number.isNaN(ms)) throw new TypeCheckError(`invalid instant '@${str}'`);
  return ms / 60000;
}

export function formatInstant(minutes) {
  return new Date(minutes * 60000).toISOString();
}

const BIN_OP = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  '==': 'EQ', '!=': 'NE', and: 'AND', or: 'OR',
};

// lineOf(name) -> line id | undefined
export function compileExpr(e, lineOf) {
  const code = [];
  const linesUsed = new Set();
  const walk = (node) => {
    switch (node.kind) {
      case 'int':
        code.push(['PUSH', { t: 'int', v: node.v }]);
        break;
      case 'dur':
        code.push(['PUSH', { t: 'duration', v: durToMinutes(node.v, node.unit) }]);
        break;
      case 'instant':
        code.push(['PUSH', { t: 'instant', v: parseInstant(node.v) }]);
        break;
      case 'bool':
        code.push(['PUSH', { t: 'bool', v: node.v }]);
        break;
      case 'ref': {
        const id = lineOf(node.name);
        if (id === undefined) throw new TypeCheckError(`'${node.name}' is not a declared line`);
        linesUsed.add(id);
        code.push(['PUSH', { t: 'line', v: id }]);
        break;
      }
      case 'call': {
        const arg = node.args[0];
        if (arg.kind !== 'ref') throw new TypeCheckError(`${node.name} argument must be a line name`);
        const id = lineOf(arg.name);
        if (id === undefined) throw new TypeCheckError(`'${arg.name}' is not a declared line`);
        linesUsed.add(id);
        code.push([node.name === 'overlap' ? 'OVERLAP' : 'TOTAL', id]);
        break;
      }
      case 'un':
        walk(node.e);
        code.push([node.op === 'neg' ? 'NEG' : 'NOT']);
        break;
      case 'bin':
        walk(node.l);
        walk(node.r);
        code.push([BIN_OP[node.op]]);
        break;
      default:
        throw new TypeCheckError(`cannot compile expression kind ${node.kind}`);
    }
  };
  walk(e);
  return { code, linesUsed };
}

class VmError extends Error {
  constructor(msg) { super(`vm error: ${msg}`); this.name = 'VmError'; }
}

function arith(op, a, b) {
  if (a.t === 'int' && b.t === 'int') return { t: 'int', v: intOp(op, a.v, b.v) };
  if (a.t === 'duration' && b.t === 'duration' && (op === 'ADD' || op === 'SUB')) {
    return { t: 'duration', v: op === 'ADD' ? a.v + b.v : a.v - b.v };
  }
  if (a.t === 'instant' && b.t === 'duration') {
    if (op === 'ADD') return { t: 'instant', v: a.v + b.v };
    if (op === 'SUB') return { t: 'instant', v: a.v - b.v };
  }
  if (a.t === 'instant' && b.t === 'instant' && op === 'SUB') return { t: 'duration', v: a.v - b.v };
  if (op === 'MUL' && a.t === 'duration' && b.t === 'int') return { t: 'duration', v: a.v * b.v };
  if (op === 'MUL' && a.t === 'int' && b.t === 'duration') return { t: 'duration', v: a.v * b.v };
  if (op === 'DIV' && a.t === 'duration' && b.t === 'int') {
    if (b.v === 0) throw new VmError('division by zero');
    return { t: 'duration', v: Math.trunc(a.v / b.v) };
  }
  throw new VmError(`bad operand types for ${op}: ${a.t}, ${b.t}`);
}

function intOp(op, x, y) {
  switch (op) {
    case 'ADD': return x + y;
    case 'SUB': return x - y;
    case 'MUL': return x * y;
    case 'DIV':
      if (y === 0) throw new VmError('division by zero');
      return Math.trunc(x / y);
    default: throw new VmError(`bad int op ${op}`);
  }
}

// ctx: { overlap(lineId) -> int, total(lineId) -> minutes }
export function runProgram(prog, ctx) {
  const stack = [];
  const pop = () => {
    if (stack.length === 0) throw new VmError('stack underflow');
    return stack.pop();
  };
  for (const ins of prog.code) {
    const op = ins[0];
    switch (op) {
      case 'PUSH': stack.push(ins[1]); break;
      case 'OVERLAP': stack.push({ t: 'int', v: ctx.overlap(ins[1]) }); break;
      case 'TOTAL': stack.push({ t: 'duration', v: ctx.total(ins[1]) }); break;
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': {
        const b = pop(); const a = pop();
        stack.push(arith(op, a, b));
        break;
      }
      case 'LT': case 'LE': case 'GT': case 'GE': {
        const b = pop(); const a = pop();
        if (a.t !== b.t || !['int', 'duration', 'instant'].includes(a.t)) {
          throw new VmError(`bad operand types for ${op}: ${a.t}, ${b.t}`);
        }
        const r = op === 'LT' ? a.v < b.v : op === 'LE' ? a.v <= b.v : op === 'GT' ? a.v > b.v : a.v >= b.v;
        stack.push({ t: 'bool', v: r });
        break;
      }
      case 'EQ': case 'NE': {
        const b = pop(); const a = pop();
        if (a.t !== b.t) throw new VmError(`bad operand types for ${op}: ${a.t}, ${b.t}`);
        stack.push({ t: 'bool', v: op === 'EQ' ? a.v === b.v : a.v !== b.v });
        break;
      }
      case 'AND': case 'OR': {
        const b = pop(); const a = pop();
        if (a.t !== 'bool' || b.t !== 'bool') throw new VmError(`${op} expects bool operands`);
        stack.push({ t: 'bool', v: op === 'AND' ? a.v && b.v : a.v || b.v });
        break;
      }
      case 'NOT': {
        const a = pop();
        if (a.t !== 'bool') throw new VmError('NOT expects bool');
        stack.push({ t: 'bool', v: !a.v });
        break;
      }
      case 'NEG': {
        const a = pop();
        if (a.t !== 'int' && a.t !== 'duration') throw new VmError('NEG expects int/duration');
        stack.push({ t: a.t, v: -a.v });
        break;
      }
      default:
        throw new VmError(`unknown opcode ${op}`);
    }
  }
  if (stack.length !== 1) throw new VmError('stack must hold exactly one value at end');
  return stack[0];
}
