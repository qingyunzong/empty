import { OP } from './compiler.js';
import { rtError } from './errors.js';
import {
  money, rate, dateVal, boolVal, formatValue,
  mulMoneyRate, mulRateRate, divRateRate,
} from './money.js';

// Stack-based VM executing the custom bytecode. Values are tagged
// ({t:'m'|'r'|'d'|'b', v}); the checker guarantees type safety, the VM
// re-verifies defensively and raises E_RT on any violation.
export class VM {
  constructor(chunk, { trace = null, usedGlobals = null } = {}) {
    this.chunk = chunk;
    this.trace = trace;
    this.usedGlobals = usedGlobals;
    this.currentFlow = null;
    this.globalVals = new Array(chunk.globals.length).fill(null);
  }

  init() {
    for (const global of this.chunk.globals) {
      this.exec(global.code, global.locs, global.consts, [], false);
    }
  }

  ruleByName(name) {
    return this.chunk.rules.findIndex((r) => r.name === name);
  }

  callRule(name, args, flowId = null) {
    const idx = this.ruleByName(name);
    if (idx === -1) throw rtError(`rule not found: '${name}'`);
    this.currentFlow = flowId;
    return this.invoke(idx, args);
  }

  invoke(ruleIdx, args) {
    const rule = this.chunk.rules[ruleIdx];
    const locals = args.slice();
    while (locals.length < rule.nLocals) locals.push(null);
    const result = this.exec(rule.code, rule.locs, rule.consts, locals, true);
    if (this.trace) {
      this.trace.push({
        flow: this.currentFlow,
        rule: rule.name,
        args: args.map(formatValue),
        result: formatValue(result),
      });
    }
    return result;
  }

  exec(code, locs, consts, locals, requireRet) {
    const stack = [];
    let ip = 0;
    const fail = (msg) => {
      const loc = locs[ip] || [null, null];
      throw rtError(msg, loc[0], loc[1]);
    };
    const pop = () => {
      if (stack.length === 0) fail('stack underflow');
      return stack.pop();
    };
    const pop2 = () => {
      const b = pop();
      const a = pop();
      return [a, b];
    };

    while (ip < code.length) {
      const ins = code[ip];
      const op = ins[0];
      switch (op) {
        case OP.PUSH_CONST: {
          const c = consts[ins[1]];
          if (c.t === 'm') stack.push(money(BigInt(c.v)));
          else if (c.t === 'r') stack.push(rate(BigInt(c.v)));
          else if (c.t === 'd') stack.push(dateVal(c.v));
          else stack.push(boolVal(c.v));
          ip++;
          break;
        }
        case OP.LOAD_GLOBAL: {
          const global = this.chunk.globals[ins[1]];
          if (this.usedGlobals) this.usedGlobals.add(global.name);
          const val = this.globalVals[global.slot];
          if (val === null) fail(`global '${global.name}' used before initialization`);
          stack.push(val);
          ip++;
          break;
        }
        case OP.LOAD_LOCAL: {
          const val = locals[ins[1]];
          if (val === null || val === undefined) fail(`local slot ${ins[1]} used before initialization`);
          stack.push(val);
          ip++;
          break;
        }
        case OP.STORE_GLOBAL:
          this.globalVals[ins[1]] = pop();
          ip++;
          break;
        case OP.STORE_LOCAL:
          locals[ins[1]] = pop();
          ip++;
          break;
        case OP.ADD:
        case OP.SUB: {
          const [a, b] = pop2();
          if (a.t !== b.t || (a.t !== 'm' && a.t !== 'r')) fail(`type mismatch in arithmetic: ${a.t}, ${b.t}`);
          stack.push({ t: a.t, v: op === OP.ADD ? a.v + b.v : a.v - b.v });
          ip++;
          break;
        }
        case OP.MUL: {
          const [a, b] = pop2();
          if (a.t === 'm' && b.t === 'r') {
            if (b.v < 0n) fail('negative rate in money*rate');
            stack.push(money(mulMoneyRate(a.v, b.v)));
          } else if (a.t === 'r' && b.t === 'm') {
            if (a.v < 0n) fail('negative rate in rate*money');
            stack.push(money(mulMoneyRate(b.v, a.v)));
          } else if (a.t === 'r' && b.t === 'r') {
            stack.push(rate(mulRateRate(a.v, b.v)));
          } else {
            fail(`type mismatch in multiplication: ${a.t}, ${b.t}`);
          }
          ip++;
          break;
        }
        case OP.DIV: {
          const [a, b] = pop2();
          if (a.t !== 'r' || b.t !== 'r') fail(`type mismatch in division: ${a.t}, ${b.t}`);
          if (b.v === 0n) fail('division by zero');
          stack.push(rate(divRateRate(a.v, b.v)));
          ip++;
          break;
        }
        case OP.NEG: {
          const a = pop();
          if (a.t !== 'm' && a.t !== 'r') fail(`cannot negate ${a.t}`);
          stack.push({ t: a.t, v: -a.v });
          ip++;
          break;
        }
        case OP.NOT: {
          const a = pop();
          if (a.t !== 'b') fail(`'not' requires bool, got ${a.t}`);
          stack.push(boolVal(!a.v));
          ip++;
          break;
        }
        case OP.EQ: case OP.NE: case OP.LT: case OP.LE: case OP.GT: case OP.GE: {
          const [a, b] = pop2();
          if (a.t !== b.t) fail(`type mismatch in comparison: ${a.t}, ${b.t}`);
          let out;
          if (op === OP.EQ) out = a.v === b.v;
          else if (op === OP.NE) out = a.v !== b.v;
          else if (op === OP.LT) out = a.v < b.v;
          else if (op === OP.LE) out = a.v <= b.v;
          else if (op === OP.GT) out = a.v > b.v;
          else out = a.v >= b.v;
          stack.push(boolVal(out));
          ip++;
          break;
        }
        case OP.JMP:
          ip = ins[1];
          break;
        case OP.JMP_IF_FALSE: {
          const a = pop();
          if (a.t !== 'b') fail(`branch condition must be bool, got ${a.t}`);
          ip = a.v ? ip + 1 : ins[1];
          break;
        }
        case OP.JMP_IF_TRUE: {
          const a = pop();
          if (a.t !== 'b') fail(`branch condition must be bool, got ${a.t}`);
          ip = a.v ? ins[1] : ip + 1;
          break;
        }
        case OP.CALL: {
          const argc = ins[2];
          const args = stack.splice(stack.length - argc, argc);
          stack.push(this.invoke(ins[1], args));
          ip++;
          break;
        }
        case OP.RET:
          return pop();
        default:
          fail(`unknown opcode ${op}`);
      }
    }
    if (requireRet) fail('code ended without RET');
    return undefined;
  }
}
