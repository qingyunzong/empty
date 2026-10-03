// Stack-based bytecode VM used to evaluate compiled rule expressions.
// Instructions are arrays: [OP, ...args]. The VM is shared by the compiler
// (to constant-fold let bindings) and by the checker (to evaluate
// when-expressions against matched event pairs).

import { jsonEq } from './semantics.js';

export function run(code, ctx = {}) {
  const stack = [];
  let ip = 0;
  const bin = (f) => {
    const b = stack.pop();
    const a = stack.pop();
    stack.push(f(a, b));
  };
  for (;;) {
    const ins = code[ip];
    switch (ins[0]) {
      case 'PUSH': stack.push(ins[1]); break;
      case 'LOAD': stack.push(ctx.slots[ins[1]]); break;
      case 'FIELD': {
        const o = stack.pop();
        stack.push(o == null ? undefined : o[ins[1]]);
        break;
      }
      case 'ADD': bin((a, b) => a + b); break;
      case 'SUB': bin((a, b) => a - b); break;
      case 'MUL': bin((a, b) => a * b); break;
      case 'DIV': bin((a, b) => a / b); break;
      case 'MOD': bin((a, b) => a % b); break;
      case 'NEG': stack.push(-stack.pop()); break;
      case 'NOT': stack.push(!stack.pop()); break;
      case 'EQ': bin((a, b) => jsonEq(a, b)); break;
      case 'NE': bin((a, b) => !jsonEq(a, b)); break;
      case 'LT': bin((a, b) => a < b); break;
      case 'LE': bin((a, b) => a <= b); break;
      case 'GT': bin((a, b) => a > b); break;
      case 'GE': bin((a, b) => a >= b); break;
      case 'JIF': {
        const c = stack.pop();
        if (!c) { ip = ins[1]; continue; }
        break;
      }
      case 'JMP': ip = ins[1]; continue;
      case 'RE': {
        if (!ins[3]) ins[3] = new RegExp(ins[1], ins[2] || '');
        const s = stack.pop();
        stack.push(typeof s === 'string' && ins[3].test(s));
        break;
      }
      case 'HB': bin((a, b) => ctx.hb(a, b)); break;
      case 'CONC': bin((a, b) => ctx.conc(a, b)); break;
      case 'COMM': bin((a, b) => ctx.comm(a, b)); break;
      case 'END': return stack.pop();
      default: throw new Error(`unknown opcode ${ins[0]}`);
    }
    ip++;
  }
}
