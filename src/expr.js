import { DslError, E_PARSE, E_SIGN } from './errors.js';

// Fixed-point scale: all money/price values are BigInt micro-units (1e6).
export const SCALE = 1_000_000n;

export function toScaled(literal, pos = null) {
  const [intPart, fracPart = ''] = literal.split('.');
  if (fracPart.length > 6) {
    throw new DslError(E_PARSE, `too many decimals (max 6): ${literal}`, pos);
  }
  const frac = fracPart.padEnd(6, '0');
  return BigInt(intPart) * SCALE + BigInt(frac === '' ? 0 : frac);
}

export function formatScaled(x) {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const intPart = a / SCALE;
  const frac = (a % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

// ---- AST evaluation (tree-walk; used by static checks and the reference fold)
export function evalAst(node, env) {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': {
      const val = env[node.name];
      if (val === undefined) throw new DslError(E_SIGN, `unknown variable '${node.name}'`);
      return val;
    }
    case 'neg': return -evalAst(node.e, env);
    case 'bin': {
      const l = evalAst(node.l, env);
      const r = evalAst(node.r, env);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return (l * r) / SCALE;
        case '/':
          if (r === 0n) throw new DslError(E_SIGN, 'division by zero');
          return (l * SCALE) / r;
        case '%':
          if (r === 0n) throw new DslError(E_SIGN, 'modulo by zero');
          return l % r;
        default: throw new DslError(E_PARSE, `bad operator ${node.op}`);
      }
    }
    default: throw new DslError(E_PARSE, 'bad expression node');
  }
}

// ---- Bytecode compilation / stack-machine execution (used by the VM)
// Ops: PUSH n | QTY | PRICE | ACCRUED | ADD | SUB | MUL | DIV | MOD | NEG
export function compileExpr(node, out = []) {
  switch (node.k) {
    case 'num': out.push(['PUSH', node.v]); break;
    case 'var':
      out.push([{ qty: 'QTY', price: 'PRICE', accrued: 'ACCRUED' }[node.name] ??
        (() => { throw new DslError(E_SIGN, `unknown variable '${node.name}'`); })()]);
      break;
    case 'neg': compileExpr(node.e, out); out.push(['NEG']); break;
    case 'bin':
      compileExpr(node.l, out);
      compileExpr(node.r, out);
      out.push([{ '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD' }[node.op]]);
      break;
    default: throw new DslError(E_PARSE, 'bad expression node');
  }
  return out;
}

export function runCode(code, env) {
  const st = [];
  for (const [op, arg] of code) {
    switch (op) {
      case 'PUSH': st.push(arg); break;
      case 'QTY': st.push(env.qty); break;
      case 'PRICE': st.push(env.price); break;
      case 'ACCRUED': st.push(env.accrued); break;
      case 'NEG': st.push(-st.pop()); break;
      case 'ADD': { const b = st.pop(); st.push(st.pop() + b); break; }
      case 'SUB': { const b = st.pop(); st.push(st.pop() - b); break; }
      case 'MUL': { const b = st.pop(); st.push((st.pop() * b) / SCALE); break; }
      case 'DIV': {
        const b = st.pop();
        if (b === 0n) throw new DslError(E_SIGN, 'division by zero');
        st.push((st.pop() * SCALE) / b);
        break;
      }
      case 'MOD': {
        const b = st.pop();
        if (b === 0n) throw new DslError(E_SIGN, 'modulo by zero');
        st.push(st.pop() % b);
        break;
      }
      default: throw new DslError(E_PARSE, `bad opcode ${op}`);
    }
  }
  if (st.length !== 1) throw new DslError(E_PARSE, 'stack imbalance');
  return st[0];
}

export function disassemble(code) {
  return code.map(([op, arg]) => (arg === undefined ? op : `${op} ${arg}`)).join('\n');
}
