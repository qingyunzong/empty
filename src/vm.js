// Stack VM: evaluates compiled bytecode against an integer-gram recipe.
export function run(code, grams) {
  const st = [];
  for (const ins of code) {
    switch (ins[0]) {
      case 'PUSH':
        st.push(ins[1]);
        break;
      case 'LOAD':
        st.push(grams[ins[1]]);
        break;
      case 'ADD': {
        const b = st.pop();
        st.push(st.pop() + b);
        break;
      }
      case 'SUB': {
        const b = st.pop();
        st.push(st.pop() - b);
        break;
      }
      case 'MUL':
        st.push(st.pop() * st.pop());
        break;
      case 'DIV': {
        const b = st.pop();
        st.push(st.pop() / b);
        break;
      }
      case 'NEG':
        st.push(-st.pop());
        break;
      case 'LT': {
        const b = st.pop();
        st.push(st.pop() < b ? 1 : 0);
        break;
      }
      case 'LE': {
        const b = st.pop();
        st.push(st.pop() <= b ? 1 : 0);
        break;
      }
      case 'GT': {
        const b = st.pop();
        st.push(st.pop() > b ? 1 : 0);
        break;
      }
      case 'GE': {
        const b = st.pop();
        st.push(st.pop() >= b ? 1 : 0);
        break;
      }
      case 'EQ': {
        const b = st.pop();
        st.push(st.pop() === b ? 1 : 0);
        break;
      }
      case 'RNG': {
        const v = st.pop();
        st.push(v >= ins[1] && v <= ins[2] ? 1 : 0);
        break;
      }
      default:
        throw new Error(`unknown opcode ${ins[0]}`);
    }
  }
  if (st.length !== 1) throw new Error('bytecode stack imbalance');
  return st[0];
}
