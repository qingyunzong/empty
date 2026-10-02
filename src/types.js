// Static type checker for rule expressions.
//
// Types: int | string | bool | pattern | any | op
// Lexical scoping: a rule block is a scope; `let` declarations are visible
// after their declaration point; predicate binders (a, b) form an inner
// scope that shadows outer `let` names. Free variables of a `let` are
// resolved at the use site.

export class DslTypeError extends Error {
  constructor(message, { file, line, col }) {
    super(message);
    this.name = 'DslTypeError';
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

const FIELDS = { op: 'string', key: 'string', value: 'any', node: 'string', time: 'int' };

export function typeCheck(program) {
  const file = program.file;
  const fail = (node, msg) => {
    throw new DslTypeError(msg, { file, line: node.line ?? 1, col: node.col ?? 1 });
  };

  for (const rule of program.rules) {
    const opNames = new Set();
    const lets = new Map(); // name -> letDecl (in declaration order)
    const deferred = [];    // predDecls checked after all members are scanned

    for (const member of rule.members) {
      if (member.kind === 'opDecl') {
        if (opNames.has(member.name)) fail(member, `duplicate operation ${JSON.stringify(member.name)}`);
        opNames.add(member.name);
        const seen = new Set();
        for (const p of member.params) {
          if (seen.has(p.name)) fail(p, `duplicate parameter ${JSON.stringify(p.name)}`);
          seen.add(p.name);
        }
      } else if (member.kind === 'letDecl') {
        if (lets.has(member.name)) fail(member, `duplicate let ${JSON.stringify(member.name)}`);
        lets.set(member.name, member);
      } else if (member.kind === 'predDecl') {
        deferred.push(member);
      }
    }

    const checkExpr = (e, binders, stack) => {
      switch (e.kind) {
        case 'lit': return e.vtype;
        case 'pat': return 'pattern';
        case 'var': {
          if (binders && binders.has(e.name)) return 'op';
          const letDecl = lets.get(e.name);
          if (!letDecl) fail(e, `undefined variable ${JSON.stringify(e.name)}`);
          if (stack.has(e.name)) fail(e, `recursive let ${JSON.stringify(e.name)}`);
          stack.add(e.name);
          const t = checkExpr(letDecl.expr, binders, stack);
          stack.delete(e.name);
          return t;
        }
        case 'field': {
          if (!binders || !binders.has(e.name)) {
            fail(e, `${JSON.stringify(e.name)} is not an operation variable in this scope`);
          }
          const t = FIELDS[e.field];
          if (!t) fail(e, `unknown field ${JSON.stringify(e.field)} (expected op, key, value, node or time)`);
          return t;
        }
        case 'not': {
          requireBool(e, checkExpr(e.expr, binders, stack));
          return 'bool';
        }
        case 'bin': {
          const lt = checkExpr(e.left, binders, stack);
          const rt = checkExpr(e.right, binders, stack);
          if (e.op === 'and' || e.op === 'or') {
            requireBool(e.left, lt);
            requireBool(e.right, rt);
            return 'bool';
          }
          if (e.op === '==' || e.op === '!=') {
            if (!compatible(lt, rt)) {
              fail(e, `cannot compare ${lt} with ${rt} using ${e.op}`);
            }
            return 'bool';
          }
          // ordering comparisons
          const okSide = (t) => t === 'int' || t === 'any';
          if (!okSide(lt) || !okSide(rt)) {
            fail(e, `operator ${e.op} requires int operands, got ${lt} and ${rt}`);
          }
          return 'bool';
        }
        default:
          fail(e, `unknown expression kind ${e.kind}`);
          return null;
      }
    };

    const requireBool = (node, t) => {
      if (t !== 'bool' && t !== 'any') fail(node, `expected a boolean expression, got ${t}`);
    };

    for (const pred of deferred) {
      const [x, y] = pred.binders;
      if (x === y) fail(pred, `duplicate binder ${JSON.stringify(x)}`);
      const binders = new Set([x, y]);
      const t = checkExpr(pred.expr, binders, new Set());
      if (t !== 'bool') fail(pred, `${pred.pred} expression must be boolean, got ${t}`);
    }
  }
  return program;
}

function compatible(a, b) {
  if (a === 'any' || b === 'any') return true;
  if (a === b) return true;
  // A pattern literal may be compared against a string (glob match).
  if ((a === 'pattern' && b === 'string') || (a === 'string' && b === 'pattern')) return true;
  return false;
}
