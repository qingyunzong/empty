import { QError } from './errors.js';

// Stack VM executing compiled guard rules against a frozen event context.
// ctx: { amount, note, bucketState(bucketIndex) -> {limit, available, frozen, used} }
export function runRules(rules, ctx) {
  for (const rule of rules) execRule(rule, ctx);
}

function execRule(rule, ctx) {
  const bc = rule.bc;
  const st = [];
  let ip = 0;
  while (ip < bc.length) {
    const ins = bc[ip];
    const op = ins[0];
    switch (op) {
      case 'PUSH': st.push(ins[1]); break;
      case 'LOAD_AMOUNT': st.push(ctx.amount); break;
      case 'LOAD_NOTE': st.push(ctx.note ?? ''); break;
      case 'LOAD_AVAIL': st.push(ctx.bucketState(ins[1]).available); break;
      case 'LOAD_FROZEN': st.push(ctx.bucketState(ins[1]).frozen); break;
      case 'LOAD_LIMIT': st.push(ctx.bucketState(ins[1]).limit); break;
      case 'LOAD_USED': st.push(ctx.bucketState(ins[1]).used); break;
      case 'NEG': st.push(-st.pop()); break;
      case 'NOT': st.push(st.pop() ? 0 : 1); break;
      case 'ADD': { const b = st.pop(); const a = st.pop(); st.push(a + b); break; }
      case 'SUB': { const b = st.pop(); const a = st.pop(); st.push(a - b); break; }
      case 'MUL': { const b = st.pop(); const a = st.pop(); st.push(a * b); break; }
      case 'DIV': {
        const b = st.pop(); const a = st.pop();
        if (b === 0) throw new QError('E_TYPE', 'division by zero in guard rule');
        st.push(a / b);
        break;
      }
      case 'EQ': { const b = st.pop(); const a = st.pop(); st.push(a === b ? 1 : 0); break; }
      case 'NE': { const b = st.pop(); const a = st.pop(); st.push(a !== b ? 1 : 0); break; }
      case 'LT': { const b = st.pop(); const a = st.pop(); st.push(a < b ? 1 : 0); break; }
      case 'LE': { const b = st.pop(); const a = st.pop(); st.push(a <= b ? 1 : 0); break; }
      case 'GT': { const b = st.pop(); const a = st.pop(); st.push(a > b ? 1 : 0); break; }
      case 'GE': { const b = st.pop(); const a = st.pop(); st.push(a >= b ? 1 : 0); break; }
      case 'AND': { const b = st.pop(); const a = st.pop(); st.push(a && b ? 1 : 0); break; }
      case 'OR': { const b = st.pop(); const a = st.pop(); st.push(a || b ? 1 : 0); break; }
      case 'MATCH': {
        const s = st.pop();
        st.push(new RegExp(ins[1]).test(String(s)) ? 1 : 0);
        break;
      }
      case 'JZ': { const v = st.pop(); if (!v) { ip = ins[1]; continue; } break; }
      case 'JNZ': { const v = st.pop(); if (v) { ip = ins[1]; continue; } break; }
      case 'REJECT': throw new QError(ins[1], `rejected by guard rule (${ins[2]})`);
      default: throw new Error(`bad opcode '${op}'`);
    }
    ip++;
  }
}
