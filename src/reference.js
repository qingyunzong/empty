// Independent reference implementation: a tree-walking evaluator used by the
// test-suite to cross-check the bytecode VM by exhaustive enumeration.
// It deliberately shares no evaluation code with compiler.js / vm.js.

const LEVELS = { minor: 1, major: 2, critical: 3 };

function frac(n, d) {
  if (d === 0) throw new Error('division by zero');
  if (d < 0) { n = -n; d = -d; }
  let a = Math.abs(n);
  let b = d;
  while (b) { const t = a % b; a = b; b = t; }
  const g = a || 1;
  return { n: n / g, d: d / g };
}

function isFrac(v) {
  return typeof v === 'object' && v !== null && 'n' in v && 'd' in v;
}

function evalExpr(node, env) {
  switch (node.kind) {
    case 'lit':
      if (node.litType === 'ratio') return { n: node.value.n, d: node.value.d };
      return node.value;
    case 'ident':
      return env.get(node.name);
    case 'un':
      if (node.op === 'not') return !evalExpr(node.expr, env);
      return -evalExpr(node.expr, env);
    case 'bin': {
      const op = node.op;
      if (op === 'and') return Boolean(evalExpr(node.left, env)) && Boolean(evalExpr(node.right, env));
      if (op === 'or') return Boolean(evalExpr(node.left, env)) || Boolean(evalExpr(node.right, env));
      const a = evalExpr(node.left, env);
      const b = evalExpr(node.right, env);
      switch (op) {
        case '+':
          if (isFrac(a) && isFrac(b)) return frac(a.n * b.d + b.n * a.d, a.d * b.d);
          return a + b;
        case '-':
          if (isFrac(a) && isFrac(b)) return frac(a.n * b.d - b.n * a.d, a.d * b.d);
          return a - b;
        case '*':
          if (isFrac(a) && isFrac(b)) return frac(a.n * b.n, a.d * b.d);
          if (isFrac(a)) return frac(a.n * b, a.d);
          if (isFrac(b)) return frac(a * b.n, b.d);
          return a * b;
        case '/':
          if (isFrac(a)) return frac(a.n, a.d * b);
          return frac(a, b);
        case '<': case '<=': case '>': case '>=': {
          const diff = isFrac(a) && isFrac(b) ? a.n * b.d - b.n * a.d : a - b;
          const asString = typeof a === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : null;
          const c = asString !== null ? asString : Math.sign(diff);
          if (op === '<') return c < 0;
          if (op === '<=') return c <= 0;
          if (op === '>') return c > 0;
          return c >= 0;
        }
        case '==':
          if (isFrac(a) && isFrac(b)) return a.n === b.n && a.d === b.d;
          return a === b;
        case '!=':
          if (isFrac(a) && isFrac(b)) return a.n !== b.n || a.d !== b.d;
          return a !== b;
        default:
          throw new Error(`unknown operator ${op}`);
      }
    }
    default:
      throw new Error(`unknown node kind ${node.kind}`);
  }
}

function convertParam(param, context) {
  const value = context[param.name];
  if (param.type === 'level' && typeof value === 'string') return LEVELS[value];
  return value;
}

export function evaluate(rule, context) {
  const env = new Map();
  for (const param of rule.params) env.set(param.name, convertParam(param, context));
  for (const c of rule.consts) env.set(c.name, evalExpr(c.expr, env));
  for (const clause of rule.clauses) {
    const local = new Map(env);
    for (const binding of clause.lets) local.set(binding.name, evalExpr(binding.expr, local));
    if (evalExpr(clause.cond, local)) return clause.verdict;
  }
  if (rule.otherwise) return rule.otherwise.verdict;
  return 'CONTINUE';
}
