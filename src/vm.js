const globCache = new Map();

export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '^';
  for (const ch of glob) {
    if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  src += '$';
  re = new RegExp(src);
  if (globCache.size > 512) globCache.clear();
  globCache.set(glob, re);
  return re;
}

function runChunk(chunks, idx, rec) {
  const code = chunks[idx];
  const stack = [];
  let ip = 0;
  while (ip < code.length) {
    const ins = code[ip];
    const op = ins[0];
    switch (op) {
      case 'CONST': stack.push(ins[1]); break;
      case 'FIELD': stack.push(rec[ins[1]]); break;
      case 'CALL': stack.push(runChunk(chunks, ins[1], rec)); break;
      case 'NOT': stack.push(!stack.pop()); break;
      case 'JFALSE':
        if (stack[stack.length - 1]) stack.pop();
        else ip = ins[1] - 1;
        break;
      case 'JTRUE':
        if (stack[stack.length - 1]) ip = ins[1] - 1;
        else stack.pop();
        break;
      case 'EQ': { const b = stack.pop(); stack.push(stack.pop() === b); break; }
      case 'NE': { const b = stack.pop(); stack.push(stack.pop() !== b); break; }
      case 'LT': { const b = stack.pop(); stack.push(stack.pop() < b); break; }
      case 'LE': { const b = stack.pop(); stack.push(stack.pop() <= b); break; }
      case 'GT': { const b = stack.pop(); stack.push(stack.pop() > b); break; }
      case 'GE': { const b = stack.pop(); stack.push(stack.pop() >= b); break; }
      case 'MATCH': { const b = stack.pop(); stack.push(globToRegExp(String(b)).test(String(stack.pop()))); break; }
      case 'NMATCH': { const b = stack.pop(); stack.push(!globToRegExp(String(b)).test(String(stack.pop()))); break; }
      default: throw new Error(`unknown opcode ${op}`);
    }
    ip++;
  }
  return stack.pop();
}

export function evaluate(compiled, rec) {
  return runChunk(compiled.chunks, 0, rec);
}

// Binary-search helpers over a sorted index of [ts, row] entries.
export function indexCandidates(entries, tsRange) {
  if (!tsRange) return entries.map((e) => e[1]);
  const { lo, loInclusive, hi, hiInclusive } = tsRange;
  let start = 0;
  let end = entries.length;
  // first index with ts > lo, or (ts == lo && loInclusive)
  let a = 0, b = entries.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    const t = entries[mid][0];
    if (t < lo || (t === lo && !loInclusive)) a = mid + 1;
    else b = mid;
  }
  start = a;
  // first index with ts > hi, or (ts == hi && !hiInclusive)
  a = 0; b = entries.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    const t = entries[mid][0];
    if (t < hi || (t === hi && hiInclusive)) a = mid + 1;
    else b = mid;
  }
  end = a;
  const rows = [];
  for (let i = start; i < end; i++) rows.push(entries[i][1]);
  return rows;
}
