// Independent reference implementation: a tree-walking evaluator over the
// typed AST. It shares only the front-end (lexer/parser/checker) with the
// production path and deliberately knows nothing about bytecode or the VM,
// so property tests can cross-check VM output against it.
import { parse } from '../src/parser.js';
import { check, LEVEL_ORDER } from '../src/checker.js';

const LEVELS = ['none', 'minor', 'major', 'critical'];

function evalExpr(node, env) {
  switch (node.kind) {
    case 'num': return node.value;
    case 'percent': return node.value;
    case 'level': return LEVEL_ORDER[node.value];
    case 'ident': return env.get(node.name);
    case 'neg': return -evalExpr(node.expr, env);
    case 'not': return !evalExpr(node.expr, env);
    case 'call': {
      const args = node.args.map((a) => evalExpr(a, env));
      switch (node.name) {
        case 'floor': return Math.floor(args[0]);
        case 'ceil': return Math.ceil(args[0]);
        case 'abs': return Math.abs(args[0]);
        case 'min': return Math.min(...args);
        case 'max': return Math.max(...args);
        default: throw new Error(`reference: unknown fn ${node.name}`);
      }
    }
    case 'bin': {
      const l = evalExpr(node.left, env);
      const r = evalExpr(node.right, env);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l === r;
        case '!=': return l !== r;
        case 'and': return l && r;
        case 'or': return l || r;
        default: throw new Error(`reference: unknown op ${node.op}`);
      }
    }
    default: throw new Error(`reference: unknown kind ${node.kind}`);
  }
}

// Returns 'ACCEPT' | 'REJECT' | 'CONTINUE'.
export function evaluateRule(source, inputs) {
  const rule = parse(source);
  check(rule);
  const env = new Map();
  for (const p of rule.params) {
    let v = inputs[p.name];
    if (p.type === 'defect_level' && typeof v === 'string') v = LEVEL_ORDER[v];
    env.set(p.name, v);
  }
  for (const stmt of rule.lets) env.set(stmt.name, evalExpr(stmt.expr, env));
  const decideEnv = new Map(env);
  for (const stmt of rule.decide.lets) decideEnv.set(stmt.name, evalExpr(stmt.expr, decideEnv));
  for (const w of rule.decide.whens) {
    if (evalExpr(w.guard, decideEnv)) return w.decision;
  }
  return rule.decide.otherwise.decision;
}

export { LEVELS };
