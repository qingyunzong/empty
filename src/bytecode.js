import { NetError, E } from './errors.js';

// Typed values at runtime: { kind, ... }
//   int:    { kind:'int', v:BigInt }
//   pct:    { kind:'pct', bp:BigInt }            basis points, 100% = 10000
//   money:  { kind:'money', v:BigInt, ccy, phase }  ccy: 'USD'|null, phase: 'gross'|'net'
//   str:    { kind:'str', v:string }
//   member: { kind:'member', v:string }
//   bool:   { kind:'bool', v:boolean }

export const FIELD_TYPES = Object.freeze({
  amount: { kind: 'money', ccy: null, phase: 'gross' },
  id: { kind: 'str' },
  from: { kind: 'member' },
  to: { kind: 'member' },
  currency: { kind: 'str' },
  day: { kind: 'str' },
});

function unifyCcy(c1, c2, what) {
  if (c1 && c2 && c1 !== c2) {
    throw new NetError(E.CCY, `currency mismatch in ${what}: ${c1} vs ${c2}`);
  }
  return c1 || c2 || null;
}

function samePhase(t1, t2, what) {
  if (t1.kind === 'money' && t2.kind === 'money' && t1.phase !== t2.phase) {
    throw new NetError(E.PARSE, `cannot mix ${t1.phase} and ${t2.phase} money in ${what}`);
  }
}

const typeErr = (msg) => { throw new NetError(E.PARSE, `type error: ${msg}`); };

// Compile an AST to stack-machine bytecode. Performs the static type check.
// Returns { code, type } where type is the expression's static type.
export function compile(node) {
  const code = [];
  const type = emit(node, code);
  code.push(['HALT']);
  return { code, type };
}

function emit(node, code) {
  switch (node.t) {
    case 'int': code.push(['PUSH_INT', node.v]); return { kind: 'int' };
    case 'pct': code.push(['PUSH_PCT', node.bp]); return { kind: 'pct' };
    case 'money': code.push(['PUSH_MONEY', node.v, node.ccy]); return { kind: 'money', ccy: node.ccy, phase: 'gross' };
    case 'str': code.push(['PUSH_STR', node.v]); return { kind: 'str' };
    case 'member': code.push(['PUSH_MEMBER', node.v]); return { kind: 'member' };
    case 'trueLit': code.push(['PUSH_BOOL', true]); return { kind: 'bool' };
    case 'falseLit': code.push(['PUSH_BOOL', false]); return { kind: 'bool' };
    case 'field': {
      const ft = FIELD_TYPES[node.name];
      if (!ft) typeErr(`unknown field ${node.name}`);
      code.push(['LOAD_FIELD', node.name]);
      return { ...ft };
    }
    case 'un': {
      const ta = emit(node.a, code);
      if (node.op === 'neg') {
        if (ta.kind !== 'int' && ta.kind !== 'money' && ta.kind !== 'pct') typeErr(`cannot negate ${ta.kind}`);
        code.push(['NEG']);
        return ta;
      }
      if (node.op === 'not') {
        if (ta.kind !== 'bool') typeErr(`not expects bool, got ${ta.kind}`);
        code.push(['NOT']);
        return { kind: 'bool' };
      }
      typeErr(`unknown unary ${node.op}`);
      break;
    }
    case 'bin': return emitBin(node, code);
    case 'call': return emitCall(node, code);
    default: typeErr(`unknown node ${node.t}`);
  }
}

function emitBin(node, code) {
  const { op } = node;
  if (op === 'and' || op === 'or') {
    const tl = emit(node.l, code);
    const tr = emit(node.r, code);
    if (tl.kind !== 'bool' || tr.kind !== 'bool') typeErr(`${op} expects bool operands`);
    code.push([op === 'and' ? 'AND' : 'OR']);
    return { kind: 'bool' };
  }
  const tl = emit(node.l, code);
  const tr = emit(node.r, code);
  switch (op) {
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      const moneyInt = (tl.kind === 'money' && tr.kind === 'int') || (tl.kind === 'int' && tr.kind === 'money');
      if (tl.kind !== tr.kind && !moneyInt) typeErr(`cannot compare ${tl.kind} with ${tr.kind}`);
      if (tl.kind === 'money' && tr.kind === 'money') {
        unifyCcy(tl.ccy, tr.ccy, 'comparison');
        samePhase(tl, tr, 'comparison');
      }
      const map = { '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE' };
      code.push([map[op]]);
      return { kind: 'bool' };
    }
    case '+': case '-': {
      if (tl.kind !== tr.kind || (tl.kind !== 'int' && tl.kind !== 'money' && tl.kind !== 'pct')) {
        typeErr(`cannot ${op === '+' ? 'add' : 'subtract'} ${tl.kind} and ${tr.kind}`);
      }
      let out = tl;
      if (tl.kind === 'money') {
        samePhase(tl, tr, op === '+' ? 'addition' : 'subtraction');
        out = { kind: 'money', ccy: unifyCcy(tl.ccy, tr.ccy, 'addition'), phase: tl.phase };
      }
      code.push([op === '+' ? 'ADD' : 'SUB']);
      return out;
    }
    case '*': {
      const k = `${tl.kind}*${tr.kind}`;
      const ok = ['int*int', 'int*pct', 'pct*int', 'pct*pct', 'money*pct', 'pct*money'];
      if (!ok.includes(k)) typeErr(`cannot multiply ${tl.kind} and ${tr.kind}`);
      code.push(['MUL']);
      if (k === 'money*pct') return { kind: 'money', ccy: tl.ccy, phase: tl.phase };
      if (k === 'pct*money') return { kind: 'money', ccy: tr.ccy, phase: tr.phase };
      if (k === 'pct*pct') return { kind: 'pct' };
      return { kind: 'int' };
    }
    case '/': {
      const k = `${tl.kind}/${tr.kind}`;
      if (k !== 'int/int' && k !== 'money/int') typeErr(`cannot divide ${tl.kind} by ${tr.kind}`);
      code.push(['DIV']);
      return tl.kind === 'money' ? { kind: 'money', ccy: tl.ccy, phase: tl.phase } : { kind: 'int' };
    }
    default: typeErr(`unknown operator ${op}`);
  }
}

function emitCall(node, code) {
  const { fn, args } = node;
  if (fn === 'min' || fn === 'max') {
    const ta = emit(args[0], code);
    const tb = emit(args[1], code);
    if (ta.kind !== tb.kind || (ta.kind !== 'int' && ta.kind !== 'money' && ta.kind !== 'pct')) {
      typeErr(`${fn} expects two numeric args of the same kind`);
    }
    let out = ta;
    if (ta.kind === 'money') {
      samePhase(ta, tb, fn);
      out = { kind: 'money', ccy: unifyCcy(ta.ccy, tb.ccy, fn), phase: ta.phase };
    }
    code.push([fn === 'min' ? 'MIN' : 'MAX']);
    return out;
  }
  if (fn === 'abs') {
    const ta = emit(args[0], code);
    if (ta.kind !== 'int' && ta.kind !== 'money' && ta.kind !== 'pct') typeErr(`abs expects numeric arg`);
    code.push(['ABS']);
    return ta;
  }
  if (fn === 'net') {
    const ta = emit(args[0], code);
    if (ta.kind !== 'money') typeErr(`net() expects money, got ${ta.kind}`);
    code.push(['NET']);
    return { kind: 'money', ccy: ta.ccy, phase: 'net' };
  }
  typeErr(`unknown function ${fn}`);
}

// ---- VM ----

const num = (v) => (v.kind === 'pct' ? v.bp : v.v);

function cmpValues(a, b) {
  if (a.kind === 'money' || a.kind === 'int' || a.kind === 'pct') {
    const x = num(a);
    const y = num(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = a.v;
  const y = b.v;
  return x < y ? -1 : x > y ? 1 : 0;
}

function rtCcy(a, b, what) {
  const c1 = a.ccy || null;
  const c2 = b.ccy || null;
  if (c1 && c2 && c1 !== c2) {
    throw new NetError(E.CCY, `currency mismatch in ${what}: ${c1} vs ${c2}`);
  }
  return c1 || c2;
}

export function run(code, obligation) {
  const st = [];
  const pop = () => st.pop();
  for (let pc = 0; pc < code.length; pc++) {
    const ins = code[pc];
    switch (ins[0]) {
      case 'PUSH_INT': st.push({ kind: 'int', v: ins[1] }); break;
      case 'PUSH_PCT': st.push({ kind: 'pct', bp: ins[1] }); break;
      case 'PUSH_MONEY': st.push({ kind: 'money', v: ins[1], ccy: ins[2], phase: 'gross' }); break;
      case 'PUSH_STR': st.push({ kind: 'str', v: ins[1] }); break;
      case 'PUSH_MEMBER': st.push({ kind: 'member', v: ins[1] }); break;
      case 'PUSH_BOOL': st.push({ kind: 'bool', v: ins[1] }); break;
      case 'LOAD_FIELD': {
        if (obligation === null) throw new NetError(E.PARSE, 'const expression must be constant (no obligation fields)');
        st.push(loadField(ins[1], obligation));
        break;
      }
      case 'NEG': {
        const a = pop();
        if (a.kind === 'pct') st.push({ ...a, bp: -a.bp });
        else st.push({ ...a, v: -a.v });
        break;
      }
      case 'NOT': st.push({ kind: 'bool', v: !pop().v }); break;
      case 'AND': { const b = pop(); const a = pop(); st.push({ kind: 'bool', v: a.v && b.v }); break; }
      case 'OR': { const b = pop(); const a = pop(); st.push({ kind: 'bool', v: a.v || b.v }); break; }
      case 'ADD': case 'SUB': {
        const b = pop();
        const a = pop();
        const sign = ins[0] === 'ADD' ? 1n : -1n;
        if (a.kind === 'money') {
          const ccy = rtCcy(a, b, ins[0] === 'ADD' ? 'addition' : 'subtraction');
          st.push({ kind: 'money', v: a.v + sign * b.v, ccy, phase: a.phase });
        } else if (a.kind === 'pct') {
          st.push({ kind: 'pct', bp: a.bp + sign * b.bp });
        } else {
          st.push({ kind: 'int', v: a.v + sign * b.v });
        }
        break;
      }
      case 'MUL': {
        const b = pop();
        const a = pop();
        if (a.kind === 'money') {
          st.push({ kind: 'money', v: (a.v * b.bp) / 10000n, ccy: a.ccy, phase: a.phase });
        } else if (b.kind === 'money') {
          st.push({ kind: 'money', v: (a.bp * b.v) / 10000n, ccy: b.ccy, phase: b.phase });
        } else if (a.kind === 'pct' && b.kind === 'pct') {
          st.push({ kind: 'pct', bp: (a.bp * b.bp) / 10000n });
        } else if (a.kind === 'pct' || b.kind === 'pct') {
          const p = a.kind === 'pct' ? a : b;
          const x = a.kind === 'pct' ? b : a;
          st.push({ kind: 'int', v: (p.bp * x.v) / 10000n });
        } else {
          st.push({ kind: 'int', v: a.v * b.v });
        }
        break;
      }
      case 'DIV': {
        const b = pop();
        const a = pop();
        if (b.v === 0n) throw new NetError(E.NO_SOL, 'division by zero while evaluating rules');
        if (a.kind === 'money') st.push({ kind: 'money', v: a.v / b.v, ccy: a.ccy, phase: a.phase });
        else st.push({ kind: 'int', v: a.v / b.v });
        break;
      }
      case 'MIN': case 'MAX': {
        const b = pop();
        const a = pop();
        const c = cmpValues(a, b);
        st.push((ins[0] === 'MIN' ? c <= 0 : c >= 0) ? a : b);
        break;
      }
      case 'ABS': {
        const a = pop();
        if (a.kind === 'pct') st.push({ ...a, bp: a.bp < 0n ? -a.bp : a.bp });
        else st.push({ ...a, v: a.v < 0n ? -a.v : a.v });
        break;
      }
      case 'NET': {
        const a = pop();
        st.push({ ...a, phase: 'net' });
        break;
      }
      case 'EQ': case 'NE': case 'LT': case 'LE': case 'GT': case 'GE': {
        const b = pop();
        const a = pop();
        if (a.kind === 'money') rtCcy(a, b, 'comparison');
        const c = cmpValues(a, b);
        const r = { EQ: c === 0, NE: c !== 0, LT: c < 0, LE: c <= 0, GT: c > 0, GE: c >= 0 }[ins[0]];
        st.push({ kind: 'bool', v: r });
        break;
      }
      case 'HALT': {
        if (st.length !== 1) throw new NetError(E.PARSE, 'bytecode stack imbalance');
        return st[0];
      }
      default: throw new NetError(E.PARSE, `unknown opcode ${ins[0]}`);
    }
  }
  throw new NetError(E.PARSE, 'bytecode missing HALT');
}

function loadField(name, obl) {
  switch (name) {
    case 'amount': return { kind: 'money', v: obl.amount, ccy: obl.ccy, phase: 'gross' };
    case 'id': return { kind: 'str', v: obl.id };
    case 'from': return { kind: 'member', v: obl.from };
    case 'to': return { kind: 'member', v: obl.to };
    case 'currency': return { kind: 'str', v: obl.ccy };
    case 'day': return { kind: 'str', v: obl.day };
    default: throw new NetError(E.PARSE, `unknown field ${name}`);
  }
}
