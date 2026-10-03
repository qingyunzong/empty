import { Rational } from './rational.js';
import { roundTo } from './rounding.js';
import { tierError, conserveError, lexError, typeError } from './errors.js';

const OVERRIDE_RE = /^(\d+(?:\.\d+)?)\s*(bps|units|[A-Z]{3})$/;

export function normalizeOrder(raw, contract) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw tierError('order must be an object');
  }
  const id = raw.id ?? '(anonymous)';
  if (raw.amount === undefined || raw.amount === null) {
    throw tierError(`order ${id}: missing amount`);
  }
  const amountStr = String(raw.amount);
  if (amountStr.startsWith('-')) {
    const what = raw.type === 'redemption' ? 'redemption' : 'order';
    throw tierError(`order ${id}: negative ${what} amount ${amountStr} is not allowed`);
  }
  const amount = Rational.fromDecimal(amountStr, 'money');

  let shares = null;
  if (raw.shares !== undefined && raw.shares !== null) {
    const sharesStr = String(raw.shares);
    if (sharesStr.startsWith('-')) throw tierError(`order ${id}: negative shares ${sharesStr}`);
    shares = Rational.fromDecimal(sharesStr, 'units');
    if (shares.isZero()) throw tierError(`order ${id}: zero shares`);
  }

  if (raw.currency && contract.currency && raw.currency !== contract.currency) {
    throw tierError(`order ${id}: currency ${raw.currency} does not match contract currency ${contract.currency}`);
  }

  const overrides = new Map();
  if (raw.overrides !== undefined) {
    if (raw.overrides === null || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
      throw tierError(`order ${id}: overrides must be an object`);
    }
    for (const [key, val] of Object.entries(raw.overrides)) {
      if (!(key in contract.paramPrograms)) {
        throw typeError(`order ${id}: override '${key}' has no matching contract default`);
      }
      const m = typeof val === 'string' ? val.match(OVERRIDE_RE) : null;
      if (!m) throw lexError(`order ${id}: malformed override literal ${JSON.stringify(val)}`);
      const unit = m[2] === 'bps' ? 'bps' : m[2] === 'units' ? 'units' : 'money';
      const value = Rational.fromDecimal(m[1], unit);
      const expected = contract.paramTypes[key];
      if (unit !== expected) {
        throw typeError(`order ${id}: override '${key}' is ${unit} but contract default is ${expected}`);
      }
      overrides.set(key, { type: unit, value });
    }
  }

  let expectedTotal = null;
  if (raw.expectedTotal !== undefined && raw.expectedTotal !== null) {
    expectedTotal = Rational.fromDecimal(String(raw.expectedTotal), 'money');
  }

  return { id, type: raw.type ?? 'subscription', amount, shares, overrides, expectedTotal };
}

export class VM {
  constructor(program) {
    this.program = program;
  }

  evalParam(name, ctx) {
    if (ctx.order.overrides.has(name)) return ctx.order.overrides.get(name);
    if (ctx.paramCache.has(name)) return ctx.paramCache.get(name);
    const code = this.program.paramPrograms[name];
    if (!code) throw typeError(`unknown parameter '${name}'`);
    const value = this.runCode(code, ctx, `param:${name}`);
    ctx.paramCache.set(name, value);
    return value;
  }

  runCode(code, ctx, label) {
    const stack = [];
    for (let pc = 0; pc < code.length; pc++) {
      const ins = code[pc];
      switch (ins.op) {
        case 'CONST_BPS':
          stack.push({ type: 'bps', value: Rational.fromDecimal(ins.value, 'bps') });
          break;
        case 'CONST_MONEY':
          stack.push({ type: 'money', value: Rational.fromDecimal(ins.value, 'money') });
          break;
        case 'CONST_UNITS':
          stack.push({ type: 'units', value: Rational.fromDecimal(ins.value, 'units') });
          break;
        case 'LOAD_PARAM':
          stack.push(this.evalParam(ins.name, ctx));
          break;
        case 'ADD': {
          const b = stack.pop(), a = stack.pop();
          if (a.type !== b.type) throw typeError(`cannot add ${a.type} and ${b.type}`);
          stack.push({ type: a.type, value: a.value.add(b.value) });
          break;
        }
        case 'MIN': {
          // minimum-fee clause: charge at least the bound
          const bound = stack.pop(), expr = stack.pop();
          stack.push({ type: 'money', value: expr.value.cmp(bound.value) < 0 ? bound.value : expr.value });
          break;
        }
        case 'MAX': {
          // fee cap clause: charge at most the bound
          const bound = stack.pop(), expr = stack.pop();
          stack.push({ type: 'money', value: expr.value.cmp(bound.value) > 0 ? bound.value : expr.value });
          break;
        }
        case 'APPLY': {
          const rate = stack.pop();
          if (rate.type !== 'bps') throw typeError(`APPLY expects bps, got ${rate.type}`);
          const exact = ctx.order.amount.mul(rate.value).div(new Rational(10000n));
          stack.push({ type: 'money', value: exact });
          break;
        }
        case 'PUSH_ORDER':
          stack.push({ type: 'money', value: ctx.order.amount });
          break;
        case 'CMP_GE': case 'CMP_LE': case 'CMP_LT': {
          const b = stack.pop(), a = stack.pop();
          const c = a.value.cmp(b.value);
          const r = ins.op === 'CMP_GE' ? c >= 0 : ins.op === 'CMP_LE' ? c <= 0 : c < 0;
          stack.push({ type: 'bool', value: r });
          break;
        }
        case 'JMP_IF_FALSE': {
          const cond = stack.pop();
          if (!cond.value) pc = ins.addr - 1;
          break;
        }
        default:
          throw new Error(`unexpected op ${ins.op} in ${label}`);
      }
    }
    if (stack.length !== 1) throw new Error(`stack imbalance in ${label}: ${stack.length}`);
    return stack[0];
  }

  execute(order) {
    const ctx = {
      order,
      paramCache: new Map(),
      matched: [],
      steps: [],
      candidates: [],
      ties: [],
      exactFee: null,
      totalFee: null,
      residual: null,
    };
    const code = this.program.main;
    const stack = [];

    for (let pc = 0; pc < code.length; pc++) {
      const ins = code[pc];
      switch (ins.op) {
        case 'PUSH_ORDER':
          stack.push({ type: 'money', value: order.amount });
          break;
        case 'CONST_MONEY':
          stack.push({ type: 'money', value: Rational.fromDecimal(ins.value, 'money') });
          break;
        case 'CONST_BPS':
          stack.push({ type: 'bps', value: Rational.fromDecimal(ins.value, 'bps') });
          break;
        case 'CONST_UNITS':
          stack.push({ type: 'units', value: Rational.fromDecimal(ins.value, 'units') });
          break;
        case 'LOAD_PARAM':
          stack.push(this.evalParam(ins.name, ctx));
          break;
        case 'ADD': {
          const b = stack.pop(), a = stack.pop();
          if (a.type !== b.type) throw typeError(`cannot add ${a.type} and ${b.type}`);
          stack.push({ type: a.type, value: a.value.add(b.value) });
          break;
        }
        case 'MIN': {
          // minimum-fee clause: charge at least the bound
          const bound = stack.pop(), expr = stack.pop();
          stack.push({ type: 'money', value: expr.value.cmp(bound.value) < 0 ? bound.value : expr.value });
          break;
        }
        case 'MAX': {
          // fee cap clause: charge at most the bound
          const bound = stack.pop(), expr = stack.pop();
          stack.push({ type: 'money', value: expr.value.cmp(bound.value) > 0 ? bound.value : expr.value });
          break;
        }
        case 'APPLY': {
          const rate = stack.pop();
          const exact = order.amount.mul(rate.value).div(new Rational(10000n));
          stack.push({ type: 'money', value: exact });
          ctx.steps.push({ pc, op: 'APPLY', rate: rate.value.toDecimal(), exactFee: exact.toDecimal() });
          break;
        }
        case 'CMP_GE': case 'CMP_LE': case 'CMP_LT': {
          const b = stack.pop(), a = stack.pop();
          const c = a.value.cmp(b.value);
          const r = ins.op === 'CMP_GE' ? c >= 0 : ins.op === 'CMP_LE' ? c <= 0 : c < 0;
          stack.push({ type: 'bool', value: r });
          break;
        }
        case 'JMP_IF_FALSE': {
          const cond = stack.pop();
          if (!cond.value) pc = ins.addr - 1;
          break;
        }
        case 'MATCH':
          ctx.matched.push(ins.tier);
          ctx.steps.push({ pc, op: 'MATCH', tier: ins.tier });
          break;
        case 'REQUIRE_MATCH':
          if (ctx.matched.length === 0) {
            throw tierError(`order ${order.id}: amount ${order.amount.toDecimal()} matches no fee tier`);
          }
          break;
        case 'SELECT_MIN': {
          for (const tierIdx of ctx.matched) {
            const feeCode = this.program.tierPrograms[tierIdx].fee;
            const result = this.runCode(feeCode, ctx, `tier:${tierIdx}`);
            if (result.type !== 'money') throw typeError(`tier ${tierIdx} fee is not money`);
            ctx.candidates.push({ tier: tierIdx, exactFee: result.value });
          }
          let best = 0;
          for (let i = 1; i < ctx.candidates.length; i++) {
            if (ctx.candidates[i].exactFee.cmp(ctx.candidates[best].exactFee) < 0) best = i;
          }
          const bestFee = ctx.candidates[best].exactFee;
          ctx.ties = ctx.candidates.filter((c) => c.exactFee.cmp(bestFee) === 0).map((c) => c.tier);
          ctx.steps.push({
            pc, op: 'SELECT_MIN',
            candidates: ctx.candidates.map((c) => ({ tier: c.tier, exactFee: c.exactFee.toDecimal() })),
            selected: ctx.candidates[best].tier,
            ties: ctx.ties,
          });
          stack.push({ type: 'money', value: bestFee });
          break;
        }
        case 'ROUND': {
          const money = stack.pop();
          if (money.type !== 'money') throw typeError(`ROUND expects money, got ${money.type}`);
          ctx.exactFee = money.value;
          const { rounded, remainder } = roundTo(money.value, 2, ins.mode);
          ctx.steps.push({
            pc, op: 'ROUND', mode: ins.mode, scale: 2,
            input: money.value.toDecimal(),
            output: rounded.toDecimal(),
            remainder: remainder.toDecimal(),
          });
          stack.push({ type: 'money', value: rounded });
          break;
        }
        case 'CONSERVE': {
          const total = stack.pop();
          ctx.totalFee = total.value;
          ctx.residual = ctx.exactFee.sub(total.value);
          // conservation identity: charged total + residual tail == exact fee owed
          const check = total.value.add(ctx.residual).cmp(ctx.exactFee) === 0;
          // residual tail must be a sub-cent fraction
          const cent = new Rational(1n, 100n);
          const tailOk = ctx.residual.abs().cmp(cent) < 0;
          ctx.steps.push({
            pc, op: 'CONSERVE',
            total: total.value.toDecimal(),
            residual: ctx.residual.toDecimal(),
            residualAccount: this.program.residualAccount,
            identity: 'total + residual == exactFee',
            identityHolds: check,
          });
          if (!check || !tailOk) {
            throw conserveError(`order ${order.id}: conservation violated (total=${total.value}, residual=${ctx.residual}, exact=${ctx.exactFee})`);
          }
          if (order.expectedTotal !== null && order.expectedTotal.cmp(total.value) !== 0) {
            throw conserveError(`order ${order.id}: reported total ${order.expectedTotal.toDecimal()} != computed components sum ${total.value.toDecimal()}`);
          }
          break;
        }
        case 'HALT':
          break;
        default:
          throw new Error(`unknown op ${ins.op}`);
      }
    }

    return {
      orderId: order.id,
      matchedTiers: ctx.matched,
      candidates: ctx.candidates.map((c) => ({ tier: c.tier, exactFee: c.exactFee.toDecimal() })),
      ties: ctx.ties,
      exactFee: ctx.exactFee.toDecimal(),
      totalFee: ctx.totalFee.toDecimalFixed(2),
      residual: ctx.residual.toDecimal(),
      residualAccount: this.program.residualAccount,
      steps: ctx.steps,
    };
  }
}
