// Rule compiler: lowers typed rule predicates to bytecode for a small
// stack VM with short-circuit jumps. The checker interprets this bytecode
// when deriving happens-before / concurrent / commutes constraints.

function globToRegExp(glob) {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

function compileExpr(e, ctx, code) {
  switch (e.kind) {
    case 'lit':
      code.push(['push', e.value]);
      break;
    case 'pat':
      code.push(['pushpat', e.value]);
      break;
    case 'var': {
      if (ctx.binders.has(e.name)) {
        code.push(['loadvar', ctx.binderIndex.get(e.name)]);
      } else {
        // Inline the let expression (resolved lexically at the use site).
        compileExpr(ctx.lets.get(e.name).expr, ctx, code);
      }
      break;
    }
    case 'field':
      code.push(['field', ctx.binderIndex.get(e.name), e.field]);
      break;
    case 'not':
      compileExpr(e.expr, ctx, code);
      code.push(['not']);
      break;
    case 'bin': {
      if (e.op === 'and') {
        compileExpr(e.left, ctx, code);
        const jz = code.length;
        code.push(['jz', null]);
        compileExpr(e.right, ctx, code);
        code[jz][1] = code.length;
      } else if (e.op === 'or') {
        compileExpr(e.left, ctx, code);
        const jt = code.length;
        code.push(['jt', null]);
        compileExpr(e.right, ctx, code);
        code[jt][1] = code.length;
      } else {
        compileExpr(e.left, ctx, code);
        compileExpr(e.right, ctx, code);
        code.push(['cmp', e.op]);
      }
      break;
    }
    default:
      throw new Error(`cannot compile expression kind ${e.kind}`);
  }
}

export function compileProgram(program) {
  const rules = program.rules.map((rule) => {
    const lets = new Map();
    for (const m of rule.members) if (m.kind === 'letDecl') lets.set(m.name, m);
    const preds = [];
    for (const m of rule.members) {
      if (m.kind !== 'predDecl') continue;
      const binderIndex = new Map([[m.binders[0], 0], [m.binders[1], 1]]);
      const ctx = { binders: new Set(m.binders), binderIndex, lets };
      const code = [];
      compileExpr(m.expr, ctx, code);
      preds.push({ pred: m.pred, code });
    }
    return {
      name: rule.name,
      ops: rule.members.filter((m) => m.kind === 'opDecl'),
      preds,
    };
  });
  return { rules };
}

function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function eqMatch(x, y) {
  if (x && x.__pattern !== undefined) return globToRegExp(x.__pattern).test(String(y));
  if (y && y.__pattern !== undefined) return globToRegExp(y.__pattern).test(String(x));
  return deepEq(x, y);
}

// Run bytecode against a pair of operation views
// [{op,key,value,node,time}, {op,key,value,node,time}].
export function runBytecode(code, pair) {
  const stack = [];
  let ip = 0;
  while (ip < code.length) {
    const ins = code[ip];
    switch (ins[0]) {
      case 'push': stack.push(ins[1]); break;
      case 'pushpat': stack.push({ __pattern: ins[1] }); break;
      case 'loadvar': stack.push(ins[1]); break;
      case 'field': stack.push(pair[ins[1]][ins[2]]); break;
      case 'not': stack.push(!stack.pop()); break;
      // Short-circuit jumps keep the deciding value on the stack when
      // jumping (it is the expression's value); otherwise they pop it.
      case 'jz': if (!stack[stack.length - 1]) { ip = ins[1]; continue; } stack.pop(); break;
      case 'jt': if (stack[stack.length - 1]) { ip = ins[1]; continue; } stack.pop(); break;
      case 'cmp': {
        const y = stack.pop();
        const x = stack.pop();
        switch (ins[1]) {
          case '==': stack.push(eqMatch(x, y)); break;
          case '!=': stack.push(!eqMatch(x, y)); break;
          case '<': stack.push(x < y); break;
          case '<=': stack.push(x <= y); break;
          case '>': stack.push(x > y); break;
          case '>=': stack.push(x >= y); break;
          default: throw new Error(`unknown comparison ${ins[1]}`);
        }
        break;
      }
      default:
        throw new Error(`unknown opcode ${ins[0]}`);
    }
    ip += 1;
  }
  return stack.pop();
}

// Evaluate all compiled predicates of a given kind for an ordered pair.
export function evalPred(compiled, predKind, viewX, viewY) {
  for (const rule of compiled.rules) {
    for (const p of rule.preds) {
      if (p.pred !== predKind) continue;
      if (runBytecode(p.code, [viewX, viewY])) return true;
    }
  }
  return false;
}
