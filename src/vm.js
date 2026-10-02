'use strict';

function run(code, ctx) {
  const stack = [];
  let ip = 0;
  while (ip < code.length) {
    const ins = code[ip];
    switch (ins.op) {
      case 'push':
        stack.push(ctx.consts[ins.k]);
        break;
      case 'load_field':
        stack.push(ctx.record[ins.field] !== undefined ? ctx.record[ins.field] : null);
        break;
      case 'load_slot':
        stack.push(ctx.slots[ins.slot]);
        break;
      case 'not':
        stack.push(!stack.pop());
        break;
      case 'jmp_false': {
        const v = stack.pop();
        if (!v) { stack.push(false); ip = ins.to; continue; }
        break;
      }
      case 'jmp_true': {
        const v = stack.pop();
        if (v) { stack.push(true); ip = ins.to; continue; }
        break;
      }
      case 'eq': { const b = stack.pop(); const a = stack.pop(); stack.push(a === b); break; }
      case 'ne': { const b = stack.pop(); const a = stack.pop(); stack.push(a !== b); break; }
      case 'lt': { const b = stack.pop(); const a = stack.pop(); stack.push(a < b); break; }
      case 'le': { const b = stack.pop(); const a = stack.pop(); stack.push(a <= b); break; }
      case 'gt': { const b = stack.pop(); const a = stack.pop(); stack.push(a > b); break; }
      case 'ge': { const b = stack.pop(); const a = stack.pop(); stack.push(a >= b); break; }
      case 'matches': {
        const v = stack.pop();
        stack.push(ctx.regexes[ins.re].test(v == null ? '' : String(v)));
        break;
      }
      default:
        throw new Error(`internal: unknown opcode '${ins.op}'`);
    }
    ip++;
  }
  return stack.pop();
}

module.exports = { run };
