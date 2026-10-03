import { typeError, scopeError } from './errors.js';

// Static checker: types (money/rate/date/bool, no implicit conversions) and
// lexical scopes (let constants, rule parameters shadow globals, unbound names
// are rejected). Also assigns storage slots used by the compiler:
//   globals -> slot in the global frame, rule params/locals -> local slots.

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.map = new Map();
  }
  define(name, info, line, col, what = 'declaration') {
    if (this.map.has(name)) {
      throw scopeError(`duplicate ${what} '${name}' in the same scope`, line, col);
    }
    this.map.set(name, info);
  }
  lookup(name) {
    let scope = this;
    while (scope) {
      if (scope.map.has(name)) return scope.map.get(name);
      scope = scope.parent;
    }
    return null;
  }
}

export function check(program) {
  const globalScope = new Scope(null);
  const ruleDecls = [];
  let nextGlobalSlot = 0;

  // Pass 1: register rule signatures so rules can call each other in any order.
  for (const decl of program.decls) {
    if (decl.type !== 'ruleDecl') continue;
    globalScope.define(decl.name, { kind: 'rule', decl }, decl.line, decl.col, 'rule');
    const seen = new Set();
    for (const p of decl.params) {
      if (seen.has(p.name)) throw scopeError(`duplicate parameter '${p.name}'`, p.line, p.col);
      seen.add(p.name);
    }
    ruleDecls.push(decl);
  }

  // Pass 2: check global param/let initializers in declaration order.
  for (const decl of program.decls) {
    if (decl.type !== 'paramDecl' && decl.type !== 'letDecl') continue;
    const initType = checkExpr(decl.expr, globalScope, { globalInit: true });
    if (initType !== decl.declaredType) {
      throw typeError(
        `'${decl.name}' is declared as ${decl.declaredType} but initialized with ${initType}`,
        decl.line, decl.col,
      );
    }
    decl.slot = nextGlobalSlot++;
    globalScope.define(decl.name, { kind: 'global', type: decl.declaredType, slot: decl.slot }, decl.line, decl.col, 'let');
  }

  // Pass 3: check rule bodies. Rule parameters shadow globals.
  for (const decl of ruleDecls) {
    const scope = new Scope(globalScope);
    decl.params.forEach((p, i) => {
      scope.define(p.name, { kind: 'local', type: p.type, slot: i }, p.line, p.col, 'parameter');
    });
    const ctx = { nextLocal: decl.params.length };
    const bodyType = checkBlock(decl.body, scope, ctx);
    if (bodyType !== decl.returnType) {
      throw typeError(
        `rule '${decl.name}' returns ${decl.returnType} but body has type ${bodyType}`,
        decl.line, decl.col,
      );
    }
    decl.nLocals = ctx.nextLocal;
  }

  return program;
}

function checkBlock(block, scope, ctx) {
  if (ctx.globalInit && block.lets.length > 0) {
    throw scopeError('let is only allowed inside rule bodies', block.lets[0].line, block.lets[0].col);
  }
  const blockScope = new Scope(scope);
  for (const letDecl of block.lets) {
    const initType = checkExpr(letDecl.expr, blockScope, ctx);
    if (initType !== letDecl.declaredType) {
      throw typeError(
        `'${letDecl.name}' is declared as ${letDecl.declaredType} but initialized with ${initType}`,
        letDecl.line, letDecl.col,
      );
    }
    letDecl.slot = ctx.nextLocal++;
    blockScope.define(letDecl.name, { kind: 'local', type: letDecl.declaredType, slot: letDecl.slot }, letDecl.line, letDecl.col, 'let');
  }
  const type = checkExpr(block.expr, blockScope, ctx);
  block.valueType = type;
  return type;
}

function checkExpr(node, scope, ctx) {
  const type = infer(node, scope, ctx);
  node.valueType = type;
  return type;
}

function infer(node, scope, ctx) {
  switch (node.type) {
    case 'moneyLit': return 'money';
    case 'rateLit': return 'rate';
    case 'dateLit': return 'date';
    case 'boolLit': return 'bool';

    case 'var': {
      const info = scope.lookup(node.name);
      if (!info) throw scopeError(`unbound variable '${node.name}'`, node.line, node.col);
      if (info.kind === 'rule') {
        throw typeError(`rule '${node.name}' must be called with arguments`, node.line, node.col);
      }
      node.resolved = { kind: info.kind, slot: info.slot };
      return info.type;
    }

    case 'call': {
      const info = scope.lookup(node.name);
      if (!info) throw scopeError(`unbound variable '${node.name}'`, node.line, node.col);
      if (info.kind !== 'rule') {
        throw typeError(`'${node.name}' is not a rule and cannot be called`, node.line, node.col);
      }
      const decl = info.decl;
      if (node.args.length !== decl.params.length) {
        throw typeError(
          `rule '${node.name}' expects ${decl.params.length} argument(s) but got ${node.args.length}`,
          node.line, node.col,
        );
      }
      node.args.forEach((arg, i) => {
        const argType = checkExpr(arg, scope, ctx);
        if (argType !== decl.params[i].type) {
          throw typeError(
            `argument ${i + 1} of rule '${node.name}' must be ${decl.params[i].type} but got ${argType}`,
            arg.line, arg.col,
          );
        }
      });
      return decl.returnType;
    }

    case 'unary': {
      const operandType = checkExpr(node.operand, scope, ctx);
      if (node.op === 'not') {
        if (operandType !== 'bool') throw typeError(`'not' requires bool but got ${operandType}`, node.line, node.col);
        return 'bool';
      }
      // unary '-'
      if (operandType !== 'money' && operandType !== 'rate') {
        throw typeError(`unary '-' requires money or rate but got ${operandType}`, node.line, node.col);
      }
      if (operandType === 'rate' && node.operand.type === 'rateLit') {
        throw typeError('negative rate literal is not allowed', node.line, node.col);
      }
      return operandType;
    }

    case 'binary': {
      const lt = checkExpr(node.left, scope, ctx);
      const rt = checkExpr(node.right, scope, ctx);
      const bad = (msg) => typeError(msg, node.line, node.col);
      switch (node.op) {
        case '+':
        case '-':
          if (lt === rt && (lt === 'money' || lt === 'rate')) return lt;
          throw bad(`cannot ${node.op === '+' ? 'add' : 'subtract'} ${lt} and ${rt} (no implicit conversion)`);
        case '*':
          if ((lt === 'money' && rt === 'rate') || (lt === 'rate' && rt === 'money')) return 'money';
          if (lt === 'rate' && rt === 'rate') return 'rate';
          throw bad(`cannot multiply ${lt} and ${rt}`);
        case '/':
          if (lt === 'rate' && rt === 'rate') return 'rate';
          throw bad(`cannot divide ${lt} by ${rt}`);
        case '<': case '<=': case '>': case '>=':
          if (lt === rt && lt !== 'bool') return 'bool';
          throw bad(`cannot compare ${lt} and ${rt}`);
        case '==': case '!=':
          if (lt === rt) return 'bool';
          throw bad(`cannot compare ${lt} and ${rt} for equality (no implicit conversion)`);
        case 'and': case 'or':
          if (lt === 'bool' && rt === 'bool') return 'bool';
          throw bad(`'${node.op}' requires bool operands but got ${lt} and ${rt}`);
        default:
          throw bad(`unknown operator '${node.op}'`);
      }
    }

    case 'if': {
      const condType = checkExpr(node.cond, scope, ctx);
      if (condType !== 'bool') throw typeError(`if condition must be bool but got ${condType}`, node.cond.line, node.cond.col);
      const thenType = checkBlock(node.thenBlock, scope, ctx);
      const elseType = checkBlock(node.elseBlock, scope, ctx);
      if (thenType !== elseType) {
        throw typeError(`if branches have different types: ${thenType} vs ${elseType}`, node.line, node.col);
      }
      return thenType;
    }

    default:
      throw typeError(`unknown expression node '${node.type}'`, node.line, node.col);
  }
}
