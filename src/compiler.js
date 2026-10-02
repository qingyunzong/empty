// Bytecode ops for the stack machine:
//   CONST v        push constant
//   FIELD name     push record field
//   EQ NE LT LE GT GE MATCH NMATCH
//   NOT
//   JFALSE addr    pop; jump if false
//   JTRUE addr     pop; jump if true
//   CALL chunk     execute chunk, push its boolean result

const CMP_OP = {
  '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  '=~': 'MATCH', '!~': 'NMATCH',
};

function compileExpr(node, code, lets) {
  switch (node.type) {
    case 'num':
    case 'time':
    case 'str':
    case 'bool':
      code.push(['CONST', node.value]);
      return;
    case 'field':
      code.push(['FIELD', node.name]);
      return;
    case 'ref':
      code.push(['CALL', node.letIndex + 1]);
      return;
    case 'not':
      compileExpr(node.expr, code, lets);
      code.push(['NOT']);
      return;
    case 'and': {
      compileExpr(node.left, code, lets);
      const jf = code.length;
      code.push(['JFALSE', null]);
      compileExpr(node.right, code, lets);
      code[jf][1] = code.length;
      return;
    }
    case 'or': {
      compileExpr(node.left, code, lets);
      const jt = code.length;
      code.push(['JTRUE', null]);
      compileExpr(node.right, code, lets);
      code[jt][1] = code.length;
      return;
    }
    case 'cmp':
      compileExpr(node.left, code, lets);
      compileExpr(node.right, code, lets);
      code.push([CMP_OP[node.op]]);
      return;
    default:
      throw new Error(`cannot compile node ${node.type}`);
  }
}

// Extract a [lo, hi] time window from top-level AND conjuncts so the
// executor can prune rows with the per-segment time index. The window is
// exact: every conjunct used here stays in the compiled filter as well.
function extractTsRange(filter) {
  let lo = -Infinity, loInc = true;
  let hi = Infinity, hiInc = true;
  const conjuncts = [];
  (function flatten(node) {
    if (node.type === 'and') { flatten(node.left); flatten(node.right); }
    else conjuncts.push(node);
  })(filter);
  for (const c of conjuncts) {
    if (c.type !== 'cmp') continue;
    let op = c.op;
    let timeVal = null;
    if (c.left.type === 'field' && c.left.name === 'ts' && c.right.type === 'time') {
      timeVal = c.right.value;
    } else if (c.right.type === 'field' && c.right.name === 'ts' && c.left.type === 'time') {
      timeVal = c.left.value;
      op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op] || op;
    } else {
      continue;
    }
    if (op === '>=' && (timeVal > lo || (timeVal === lo && !loInc))) { lo = timeVal; loInc = true; }
    else if (op === '>' && (timeVal >= lo)) { lo = timeVal; loInc = false; }
    else if (op === '<=' && (timeVal < hi || (timeVal === hi && !hiInc))) { hi = timeVal; hiInc = true; }
    else if (op === '<' && (timeVal <= hi)) { hi = timeVal; hiInc = false; }
    else if (op === '==') {
      if (timeVal > lo || (timeVal === lo && !loInc)) { lo = timeVal; loInc = true; }
      if (timeVal < hi || (timeVal === hi && !hiInc)) { hi = timeVal; hiInc = true; }
    }
  }
  if (lo === -Infinity && hi === Infinity) return null;
  return { lo, loInclusive: loInc, hi, hiInclusive: hiInc };
}

export function compile(program) {
  const chunks = [];
  chunks.push(compileChunk(program.filter, program.lets));
  for (const decl of program.lets) {
    chunks.push(compileChunk(decl.expr, program.lets));
  }
  return {
    chunks,
    tsRange: extractTsRange(program.filter),
    aggs: program.aggs,
    groupBy: program.groupBy,
  };
}

function compileChunk(expr, lets) {
  const code = [];
  compileExpr(expr, code, lets);
  return code;
}
