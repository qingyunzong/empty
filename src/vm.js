// Replays compiled bytecode exactly once per instruction.
// State model: per-key commit history stack plus a visible view.
//   COMMIT   pushes a value and makes it visible
//   MASK     hides the key from the visible view (history kept)
//   ROLLBACK pops the newest commit, restoring the previous visible value
//   CONFLICT halts the replay; the committed prefix is preserved and the
//            conflicting events never enter the state
export function run(bytecode) {
  const history = new Map(); // key -> [values]
  const masked = new Set();
  let conflict = null;
  let applied = 0;

  const visible = () => {
    const view = {};
    for (const [key, stack] of history) {
      if (stack.length > 0 && !masked.has(key)) view[key] = stack[stack.length - 1];
    }
    return view;
  };

  for (const ins of bytecode) {
    if (ins.op === 'CONFLICT') {
      conflict = ins.certificate;
      break;
    }
    if (ins.op === 'COMMIT') {
      if (!history.has(ins.key)) history.set(ins.key, []);
      history.get(ins.key).push(ins.value);
      masked.delete(ins.key);
    } else if (ins.op === 'MASK') {
      masked.add(ins.key);
    } else if (ins.op === 'ROLLBACK') {
      const stack = history.get(ins.key);
      if (stack && stack.length > 0) stack.pop();
    } else {
      throw new Error(`unknown opcode: ${ins.op}`);
    }
    applied += 1;
  }

  return { state: visible(), conflict, applied };
}
