import { NetError, E } from './errors.js';

// Stack-machine bytecode. Expressions are typechecked before compilation,
// so the VM only re-asserts currency/kind compatibility at runtime.
//
// Values are tagged: { t: 'int'|'bps'|'bool'|'ccy'|'member'|'obid'|'date'|'money', v, ccy?, kind? }

export function compileExpr(node, constValues, ops = []) {
  switch (node.t) {
    case 'int': ops.push(['PUSH', { t: 'int', v: node.v }]); break;
    case 'bps': ops.push(['PUSH', { t: 'bps', v: node.v }]); break;
    case 'bool': ops.push(['PUSH', { t: 'bool', v: node.v }]); break;
    case 'ccy': ops.push(['PUSH', { t: 'ccy', v: node.v }]); break;
    case 'member': ops.push(['PUSH', { t: 'member', v: node.v }]); break;
    case 'obid': ops.push(['PUSH', { t: 'obid', v: node.v }]); break;
    case 'date': ops.push(['PUSH', { t: 'date', v: node.v }]); break;
    case 'money': ops.push(['PUSH', { t: 'money', ccy: node.ccy, kind: 'any', v: node.amount }]); break;
    case 'ident': {
      if (constValues.has(node.name)) ops.push(['PUSH', constValues.get(node.name)]);
      else ops.push(['LOAD', node.name]);
      break;
    }
    case 'un':
      compileExpr(node.e, constValues, ops);
      ops.push([node.op === 'neg' ? 'NEG' : 'NOT']);
      break;
    case 'bin':
      compileExpr(node.l, constValues, ops);
      compileExpr(node.r, constValues, ops);
      ops.push([node.op]);
      break;
    case 'call':
      for (const a of node.args) compileExpr(a, constValues, ops);
      ops.push([node.fn.toUpperCase()]);
      break;
    default:
      throw new NetError(E.PARSE, `internal: cannot compile node ${node.t}`);
  }
  return ops;
}

export function compileProgram(typed) {
  const blocks = new Map();
  for (const b of typed.blocks) {
    const constValues = new Map();
    for (const c of b.consts) {
      const ops = compileExpr(c.expr, constValues);
      constValues.set(c.name, vm(ops, {}));
    }
    let filterOps = null;
    if (b.filters.length > 0) {
      filterOps = [];
      b.filters.forEach((f, i) => {
        compileExpr(f, constValues, filterOps);
        if (i > 0) filterOps.push(['AND']);
      });
    }
    const settles = b.settles.map((s) => ({
      name: s.name,
      ops: compileExpr(s.expr, constValues),
    }));
    blocks.set(b.date, { date: b.date, filterOps, settles });
  }
  return blocks;
}

function promote(a, b) {
  if (a.t === 'int' && b.t === 'money') {
    return [{ t: 'money', ccy: b.ccy, kind: 'any', v: a.v }, b];
  }
  if (b.t === 'int' && a.t === 'money') {
    return [a, { t: 'money', ccy: a.ccy, kind: 'any', v: b.v }];
  }
  return [a, b];
}

function mergeMoney(a, b) {
  if (a.ccy && b.ccy && a.ccy !== b.ccy) {
    throw new NetError(E.CCY, `cannot combine ${a.ccy} with ${b.ccy}`);
  }
  if (a.kind !== 'any' && b.kind !== 'any' && a.kind !== b.kind) {
    throw new NetError(E.TYPE, `cannot treat a ${a.kind} amount as ${b.kind}`);
  }
  return { ccy: a.ccy || b.ccy, kind: a.kind !== 'any' ? a.kind : b.kind };
}

function binop(op, x, y) {
  const [a, b] = promote(x, y);
  switch (op) {
    case 'PLUS': case 'MINUS': {
      const d = op === 'PLUS' ? 1 : -1;
      if (a.t === 'int') return { t: 'int', v: a.v + d * b.v };
      if (a.t === 'bps') return { t: 'bps', v: a.v + d * b.v };
      const m = mergeMoney(a, b);
      return { t: 'money', ccy: m.ccy, kind: m.kind, v: a.v + d * b.v };
    }
    case 'STAR': {
      if (a.t === 'int' && b.t === 'int') return { t: 'int', v: a.v * b.v };
      if (a.t === 'int' && b.t === 'bps') return { t: 'int', v: Math.trunc(a.v * b.v / 10000) };
      if (a.t === 'bps' && b.t === 'int') return { t: 'int', v: Math.trunc(a.v * b.v / 10000) };
      if (a.t === 'money' && b.t === 'bps') return { ...a, v: Math.trunc(a.v * b.v / 10000) };
      if (a.t === 'bps' && b.t === 'money') return { ...b, v: Math.trunc(a.v * b.v / 10000) };
      break;
    }
    case 'MIN': case 'MAX': {
      if (a.t === 'money') mergeMoney(a, b);
      const take = (op === 'MIN' ? a.v <= b.v : a.v >= b.v) ? a : b;
      return take;
    }
    case 'EQ': case 'NE': {
      let eq;
      if (a.t !== b.t) eq = false;
      else if (a.t === 'money') eq = a.v === b.v && a.ccy === b.ccy;
      else eq = a.v === b.v;
      return { t: 'bool', v: op === 'EQ' ? eq : !eq };
    }
    case 'LT': case 'LE': case 'GT': case 'GE': {
      if (a.t === 'money') mergeMoney(a, b);
      const v = op === 'LT' ? a.v < b.v
        : op === 'LE' ? a.v <= b.v
        : op === 'GT' ? a.v > b.v
        : a.v >= b.v;
      return { t: 'bool', v };
    }
    case 'AND': return { t: 'bool', v: a.v && b.v };
    case 'OR': return { t: 'bool', v: a.v || b.v };
    default: break;
  }
  throw new NetError(E.TYPE, `invalid operands for ${op}: ${x.t} and ${y.t}`);
}

export function vm(ops, env) {
  const st = [];
  for (const ins of ops) {
    const op = ins[0];
    const arg = ins[1];
    switch (op) {
      case 'PUSH': st.push(arg); break;
      case 'LOAD': {
        const v = env[arg];
        if (v === undefined) throw new Error(`internal: missing field '${arg}'`);
        st.push(v);
        break;
      }
      case 'NEG': {
        const a = st.pop();
        st.push({ ...a, v: -a.v });
        break;
      }
      case 'NOT': {
        const a = st.pop();
        st.push({ t: 'bool', v: !a.v });
        break;
      }
      case 'ABS': {
        const a = st.pop();
        st.push({ ...a, v: Math.abs(a.v) });
        break;
      }
      default: {
        const b = st.pop();
        const a = st.pop();
        st.push(binop(op, a, b));
      }
    }
  }
  if (st.length !== 1) throw new Error('internal: corrupt bytecode stack');
  return st[0];
}
