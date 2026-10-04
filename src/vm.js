'use strict';

const { DslError } = require('./errors');
const { OP, OPNAME, RATE_SCALE } = require('./compiler');

function rt(msg) {
  throw new DslError('E_RT', msg, 0, 0);
}

function roundDiv(a, b) {
  // round half away from zero, b > 0
  let q = a / b;
  const r = a % b;
  const ar = r < 0n ? -r : r;
  if (ar * 2n >= b) q += r < 0n ? -1n : 1n;
  return q;
}

function decode(type, s) {
  if (type === 'money' || type === 'rate') return BigInt(s);
  if (type === 'date') return Number(s);
  if (type === 'bool') return s === '1';
  rt(`unknown value type '${type}'`);
}

function typeOf(v) {
  return v === null || v === undefined ? '<void>' : v.t;
}

class VM {
  constructor(program, trace) {
    this.prog = program;
    this.trace = trace || [];
    this.globals = new Array(program.globals).fill(null);
    this.runFrames({
      rule: { name: '<init>', arity: 0, nslots: 0 },
      code: program.init,
      ip: 0,
      slots: [],
      stack: [],
    });
  }

  mkFrame(idx, argv) {
    const rule = this.prog.rules[idx];
    if (!rule) rt(`no rule at index ${idx}`);
    if (argv.length !== rule.arity) {
      rt(`rule '${rule.name}' expects ${rule.arity} argument(s), got ${argv.length}`);
    }
    const slots = new Array(rule.nslots).fill(null);
    argv.forEach((v, i) => { slots[i] = v; });
    return { rule, code: rule.code, ip: 0, slots, stack: [] };
  }

  callRule(idx, args) {
    return this.runFrames(this.mkFrame(idx, args));
  }

  runFrames(frame) {
    const frames = [frame];
    for (;;) {
      const f = frames[frames.length - 1];
      if (f.ip >= f.code.length) {
        rt(`rule '${f.rule.name}' ended without a return`);
      }
      const ins = f.code[f.ip++];
      const op = ins[0];
      this.trace.push(OPNAME[op] === undefined ? `OP${op}` : OPNAME[op]);
      switch (op) {
        case OP.PUSH:
          f.stack.push({ t: ins[1][0], v: decode(ins[1][0], ins[1][1]) });
          break;
        case OP.LOADG:
          f.stack.push(this.globals[ins[1]]);
          break;
        case OP.LOADL:
          f.stack.push(f.slots[ins[1]]);
          break;
        case OP.STOREG:
          this.globals[ins[1]] = f.stack.pop();
          break;
        case OP.STOREL:
          f.slots[ins[1]] = f.stack.pop();
          break;
        case OP.ADD:
        case OP.SUB: {
          const b = f.stack.pop();
          const a = f.stack.pop();
          if (!a || !b || a.t !== b.t || (a.t !== 'money' && a.t !== 'rate')) {
            rt(`cannot add/subtract ${typeOf(a)} and ${typeOf(b)}`);
          }
          f.stack.push({ t: a.t, v: op === OP.ADD ? a.v + b.v : a.v - b.v });
          break;
        }
        case OP.MUL: {
          const b = f.stack.pop();
          const a = f.stack.pop();
          if (!a || !b) rt('stack underflow in MUL');
          if ((a.t === 'money' && b.t === 'rate') || (a.t === 'rate' && b.t === 'money')) {
            f.stack.push({ t: 'money', v: roundDiv(a.v * b.v, RATE_SCALE) });
          } else if (a.t === 'rate' && b.t === 'rate') {
            f.stack.push({ t: 'rate', v: roundDiv(a.v * b.v, RATE_SCALE) });
          } else {
            rt(`cannot multiply ${typeOf(a)} and ${typeOf(b)}`);
          }
          break;
        }
        case OP.NEG: {
          const a = f.stack.pop();
          if (!a || a.t !== 'money') rt(`cannot negate ${typeOf(a)}`);
          f.stack.push({ t: 'money', v: -a.v });
          break;
        }
        case OP.NOT: {
          const a = f.stack.pop();
          if (!a || a.t !== 'bool') rt(`'not' requires bool, got ${typeOf(a)}`);
          f.stack.push({ t: 'bool', v: !a.v });
          break;
        }
        case OP.AND:
        case OP.OR: {
          const b = f.stack.pop();
          const a = f.stack.pop();
          if (!a || !b || a.t !== 'bool' || b.t !== 'bool') {
            rt(`logic operator requires bool operands, got ${typeOf(a)} and ${typeOf(b)}`);
          }
          f.stack.push({ t: 'bool', v: op === OP.AND ? a.v && b.v : a.v || b.v });
          break;
        }
        case OP.EQ:
        case OP.NE: {
          const b = f.stack.pop();
          const a = f.stack.pop();
          if (!a || !b) rt('stack underflow in comparison');
          const eq = a.t === b.t && a.v === b.v;
          f.stack.push({ t: 'bool', v: op === OP.EQ ? eq : !eq });
          break;
        }
        case OP.LT:
        case OP.LE:
        case OP.GT:
        case OP.GE: {
          const b = f.stack.pop();
          const a = f.stack.pop();
          if (!a || !b || a.t !== b.t || a.t === 'bool') {
            rt(`cannot order ${typeOf(a)} and ${typeOf(b)}`);
          }
          let v;
          if (op === OP.LT) v = a.v < b.v;
          else if (op === OP.LE) v = a.v <= b.v;
          else if (op === OP.GT) v = a.v > b.v;
          else v = a.v >= b.v;
          f.stack.push({ t: 'bool', v });
          break;
        }
        case OP.JMP:
          f.ip = ins[1];
          break;
        case OP.JF: {
          const c = f.stack.pop();
          if (!c || c.t !== 'bool') rt(`jump condition must be bool, got ${typeOf(c)}`);
          if (!c.v) f.ip = ins[1];
          break;
        }
        case OP.CALL: {
          const idx = ins[1];
          const rule = this.prog.rules[idx];
          if (!rule) rt(`no rule at index ${idx}`);
          const argv = f.stack.splice(f.stack.length - rule.arity, rule.arity);
          frames.push(this.mkFrame(idx, argv));
          if (frames.length > 10000) rt('call stack overflow');
          break;
        }
        case OP.RET: {
          const v = f.stack.pop();
          if (v === undefined) rt(`rule '${f.rule.name}' returned with empty stack`);
          frames.pop();
          if (frames.length === 0) return v;
          frames[frames.length - 1].stack.push(v);
          break;
        }
        case OP.ROUND: {
          const a = f.stack.pop();
          if (!a || a.t !== 'money') rt(`round expects money, got ${typeOf(a)}`);
          f.stack.push(a);
          break;
        }
        default:
          rt(`unknown opcode ${op}`);
      }
    }
  }
}

function fmtMoney(cents) {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  const s = a.toString().padStart(3, '0');
  return (neg ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
}

function parseMoney(str, ctx) {
  if (typeof str !== 'string' || !/^-?\d+(\.\d{1,2})?$/.test(str)) {
    throw new DslError('E_RT', `invalid money amount '${str}' in ${ctx}`, 0, 0);
  }
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const [intPart, fracPart = ''] = body.split('.');
  const cents = BigInt(intPart) * 100n + BigInt((fracPart + '00').slice(0, 2));
  return neg ? -cents : cents;
}

function parseDate(str, ctx) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof str === 'string' ? str : '');
  if (!m) throw new DslError('E_RT', `invalid date '${str}' in ${ctx}`, 0, 0);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new DslError('E_RT', `invalid date '${str}' in ${ctx}`, 0, 0);
  }
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

module.exports = { VM, roundDiv, fmtMoney, parseMoney, parseDate };
