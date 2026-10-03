import { err } from './errors.js';

const NUMERIC = new Set(['money', 'bps', 'units']);

// Integer division with explicit rounding mode. v / s, s > 0.
// Returns the rounded quotient q and the truncation remainder r (sign of v).
export function divRound(v, s, mode) {
  const q = v / s;
  const r = v % s;
  if (r === 0n) return { q, r };
  const ar = r < 0n ? -r : r;
  const sign = v < 0n ? -1n : 1n;
  let adj = 0n;
  if (mode === 'HALF_UP') {
    if (ar * 2n >= s) adj = sign;
  } else if (mode === 'HALF_EVEN') {
    const d = ar * 2n;
    if (d > s || (d === s && q % 2n !== 0n)) adj = sign;
  } else if (mode === 'DOWN') {
    // truncate toward zero: nothing to do
  } else {
    throw err('E_ROUND', `unknown rounding mode '${mode}'`);
  }
  return { q: q + adj, r };
}

const val = (t, v, scale = 1n) => ({ t, v, scale });

export function runFee(contract, className, opName, args, orderParams) {
  const cls = contract.classes.get(className);
  if (!cls) throw err('E_ORDER', `unknown share class '${className}'`);
  const fn = cls.fns.get(opName);
  if (!fn) throw err('E_ORDER', `class '${className}' has no fee rule for op '${opName}'`);

  const locals = new Map();
  for (const prm of fn.params) {
    if (!args.has(prm.name)) throw err('E_ORDER', `missing argument '${prm.name}' for ${className}.${opName}`);
    const a = args.get(prm.name);
    if (a.t !== prm.type) {
      throw err('E_ORDER', `argument '${prm.name}' expects ${prm.type}, got ${a.t}`);
    }
    locals.set(prm.name, val(a.t, a.v));
  }
  for (const name of args.keys()) {
    if (!fn.params.some((prm) => prm.name === name)) {
      throw err('E_ORDER', `unknown argument '${name}' for ${className}.${opName}`);
    }
  }

  const load = (name) => {
    if (locals.has(name)) return locals.get(name);
    if (orderParams && orderParams.has(name)) { const p = orderParams.get(name); return val(p.t, p.v); }
    if (cls.params.has(name)) { const p = cls.params.get(name); return val(p.t, p.v); }
    if (contract.params.has(name)) { const p = contract.params.get(name); return val(p.t, p.v); }
    throw err('E_NAME', `undefined name '${name}'`);
  };

  const stack = [];
  const trace = [];
  const tierStack = [];
  const tiers = [];
  const allocations = [];
  const { code, consts } = fn;
  let pc = 0;
  let result = null;

  const step = (entry) => {
    trace.push({ step: trace.length, pc, ...entry });
  };
  const pop = () => stack.pop();
  const popNum = (what) => {
    const a = pop();
    if (!NUMERIC.has(a.t)) throw err('E_TYPE', `${what} requires numeric operands, got ${a.t}`);
    return a;
  };
  const popBool = (what) => {
    const a = pop();
    if (a.t !== 'bool') throw err('E_TYPE', `${what} requires a bool operand, got ${a.t}`);
    return a;
  };
  const sameType = (a, b, what) => {
    if (a.t !== b.t) throw err('E_TYPE', `${what} requires matching types, got ${a.t} and ${b.t}`);
    if (a.scale !== 1n || b.scale !== 1n) throw err('E_TYPE', `${what} requires rounded operands`);
  };

  while (pc < code.length) {
    const instr = code[pc];
    switch (instr.op) {
      case 'PUSH': {
        const c = consts[instr.k];
        stack.push(val(c.t, c.v));
        break;
      }
      case 'LOAD':
        stack.push(load(instr.name));
        break;
      case 'STORE':
        locals.set(instr.name, pop());
        break;
      case 'NEG': {
        const a = popNum('NEG');
        stack.push(val(a.t, -a.v, a.scale));
        break;
      }
      case 'NOT': {
        const a = popBool('NOT');
        stack.push(val('bool', a.v === 0n ? 1n : 0n));
        break;
      }
      case 'AND': {
        const b = popBool('AND');
        const a = popBool('AND');
        stack.push(val('bool', a.v !== 0n && b.v !== 0n ? 1n : 0n));
        break;
      }
      case 'OR': {
        const b = popBool('OR');
        const a = popBool('OR');
        stack.push(val('bool', a.v !== 0n || b.v !== 0n ? 1n : 0n));
        break;
      }
      case 'ADD':
      case 'SUB': {
        const b = popNum(instr.op);
        const a = popNum(instr.op);
        sameType(a, b, instr.op);
        stack.push(val(a.t, instr.op === 'ADD' ? a.v + b.v : a.v - b.v));
        break;
      }
      case 'MUL': {
        const b = popNum('MUL');
        const a = popNum('MUL');
        const pair = `${a.t}*${b.t}`;
        if (pair === 'money*bps' || pair === 'bps*money') {
          stack.push(val('money', a.v * b.v, 10000n));
        } else if (pair === 'units*money' || pair === 'money*units') {
          stack.push(val('money', a.v * b.v));
        } else {
          throw err('E_TYPE', `invalid multiplication ${pair}`);
        }
        break;
      }
      case 'ROUND': {
        const a = pop();
        if (a.t !== 'money') throw err('E_TYPE', `ROUND requires money, got ${a.t}`);
        const { q, r } = divRound(a.v, a.scale, instr.mode);
        step({ op: 'ROUND', mode: instr.mode, in: String(a.v), scale: String(a.scale), rem: String(r), out: String(q) });
        stack.push(val('money', q));
        break;
      }
      case 'MIN':
      case 'MAX': {
        const b = popNum(instr.op);
        const a = popNum(instr.op);
        sameType(a, b, instr.op);
        const pick = instr.op === 'MIN' ? (a.v <= b.v ? a : b) : (a.v >= b.v ? a : b);
        stack.push(val(a.t, pick.v));
        break;
      }
      case 'CMP': {
        const b = pop();
        const a = pop();
        sameType(a, b, 'CMP');
        let res;
        if (instr.cmp === '<') res = a.v < b.v;
        else if (instr.cmp === '<=') res = a.v <= b.v;
        else if (instr.cmp === '>') res = a.v > b.v;
        else if (instr.cmp === '>=') res = a.v >= b.v;
        else if (instr.cmp === '==') res = a.v === b.v;
        else if (instr.cmp === '!=') res = a.v !== b.v;
        else throw err('E_TYPE', `unknown comparison '${instr.cmp}'`);
        stack.push(val('bool', res ? 1n : 0n));
        break;
      }
      case 'JMP_IF_FALSE': {
        const c = popBool('JMP_IF_FALSE');
        if (c.v === 0n) { pc = instr.addr; continue; }
        break;
      }
      case 'JMP':
        pc = instr.addr;
        continue;
      case 'TIER_BEGIN':
        tierStack.push({ id: instr.id, accs: [] });
        break;
      case 'TIER_ACC': {
        const ctx = tierStack[tierStack.length - 1];
        if (!ctx || ctx.id !== instr.id) throw err('E_TIER', `tier ${instr.id} accumulator mismatch`);
        const v = popNum('TIER_ACC');
        ctx.accs.push({ arm: instr.arm, t: v.t, v: v.v });
        break;
      }
      case 'TIER_END': {
        const ctx = tierStack.pop();
        if (!ctx || ctx.id !== instr.id) throw err('E_TIER', `tier ${instr.id} end mismatch`);
        if (ctx.accs.length === 0) {
          throw err('E_TIER', `tier ${instr.id}: no arm matched and no else arm present`);
        }
        let best = ctx.accs[0];
        for (const a of ctx.accs) if (a.v < best.v) best = a;
        const ties = ctx.accs.filter((a) => a.v === best.v).map((a) => a.arm);
        const rec = {
          id: ctx.id,
          matches: ctx.accs.map((a) => ({ arm: a.arm, type: a.t, value: String(a.v) })),
          chosen: String(best.v),
          ties,
        };
        tiers.push(rec);
        step({ op: 'TIER', ...rec });
        stack.push(val(best.t, best.v));
        break;
      }
      case 'CONSERVE': {
        const right = pop();
        const left = pop();
        if (left.t !== right.t || left.v !== right.v) {
          step({ op: 'CONSERVE', left: String(left.v), right: String(right.v), ok: false });
          throw err('E_CONSERVE', `conservation violated: total ${left.v} != parts sum ${right.v} (${left.t})`);
        }
        step({ op: 'CONSERVE', left: String(left.v), right: String(right.v), ok: true });
        break;
      }
      case 'ALLOC': {
        const n = instr.accounts.length;
        const shares = [];
        for (let k = 0; k < n; k += 1) shares.unshift(pop());
        const total = pop();
        if (total.t !== 'money' || total.scale !== 1n) {
          throw err('E_TYPE', 'ALLOC total must be rounded money');
        }
        const components = {};
        let sum = 0n;
        instr.accounts.forEach((account, idx) => {
          const sh = shares[idx];
          if (sh.t !== 'bps') throw err('E_TYPE', `ALLOC share for '${account}' must be bps, got ${sh.t}`);
          const raw = total.v * sh.v;
          const { q, r } = divRound(raw, 10000n, contract.rounding);
          step({ op: 'ROUND', mode: contract.rounding, account, in: String(raw), scale: '10000', rem: String(r), out: String(q) });
          components[account] = q;
          sum += q;
        });
        const residual = total.v - sum;
        if (residual < 0n) {
          throw err('E_CONSERVE', `allocations sum to ${sum}, exceeding total ${total.v} by ${-residual}`);
        }
        if (sum + residual !== total.v) {
          throw err('E_CONSERVE', `conservation violated: components ${sum} + residual ${residual} != total ${total.v}`);
        }
        const compStr = {};
        for (const [k, v] of Object.entries(components)) compStr[k] = String(v);
        step({ op: 'ALLOC', total: String(total.v), components: compStr, residual: { account: instr.residual, amount: String(residual) } });
        allocations.push({ total: String(total.v), components: compStr, residual: { account: instr.residual, amount: String(residual) } });
        break;
      }
      case 'RET': {
        const v = pop();
        if (v.scale !== 1n) throw err('E_TYPE', 'cannot return an unrounded intermediate value');
        result = v;
        break;
      }
      default:
        throw err('E_TYPE', `unknown opcode '${instr.op}'`);
    }
    pc += 1;
  }

  if (result === null) throw err('E_ORDER', `fee rule '${opName}' did not return a value`);
  return { value: result, trace, tiers, allocations };
}
