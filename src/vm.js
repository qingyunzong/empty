// Stack VM over exact rationals. Evaluates compiled constraint and objective
// bytecode for a concrete integer-gram assignment.

import { OP } from './compile.js';
import { rat, radd, rsub, rmul, rdiv, rneg } from './rational.js';

export class VMError extends Error {}

export function run(code, grams) {
  const stack = [];
  for (const ins of code) {
    switch (ins.op) {
      case OP.PUSH:
        stack.push(rat(ins.n, ins.d));
        break;
      case OP.LOAD:
        stack.push(rat(BigInt(grams[ins.arg])));
        break;
      case OP.ADD: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(radd(a, b));
        break;
      }
      case OP.SUB: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(rsub(a, b));
        break;
      }
      case OP.MUL: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(rmul(a, b));
        break;
      }
      case OP.DIV: {
        const b = stack.pop();
        const a = stack.pop();
        if (b.n === 0n) throw new VMError('division by zero during evaluation');
        stack.push(rdiv(a, b));
        break;
      }
      case OP.NEG:
        stack.push(rneg(stack.pop()));
        break;
      default:
        throw new VMError(`unknown opcode ${ins.op}`);
    }
  }
  if (stack.length !== 1) throw new VMError('bytecode left a malformed stack');
  return stack[0];
}
