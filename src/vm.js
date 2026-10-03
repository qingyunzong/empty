import { cidrContains } from './ip.js';

const CMP = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

// Stack-machine VM. Static type checking guarantees operand shapes.
export function runCode(code, regexObjs, event) {
  const st = [];
  for (const ins of code) {
    switch (ins.op) {
      case 'const':
        st.push(ins.value);
        break;
      case 're':
        st.push(regexObjs[ins.idx]);
        break;
      case 'field':
        st.push(event[ins.name]);
        break;
      case 'not':
        st.push(!st.pop());
        break;
      case 'and': {
        const b = st.pop();
        const a = st.pop();
        st.push(Boolean(a && b));
        break;
      }
      case 'or': {
        const b = st.pop();
        const a = st.pop();
        st.push(Boolean(a || b));
        break;
      }
      case 'cmp': {
        const b = st.pop();
        const a = st.pop();
        st.push(CMP[ins.cmp](a, b));
        break;
      }
      case 'in_cidr': {
        const c = st.pop();
        const ip = st.pop();
        st.push(cidrContains(c, ip));
        break;
      }
      case 'in_range': {
        const r = st.pop();
        const v = st.pop();
        st.push(v >= r[0] && v <= r[1]);
        break;
      }
      case 'in_regex': {
        const re = st.pop();
        const s = st.pop();
        st.push(re.test(s));
        break;
      }
      default:
        throw new Error(`unknown opcode ${ins.op}`);
    }
  }
  return st[st.length - 1] === true;
}
