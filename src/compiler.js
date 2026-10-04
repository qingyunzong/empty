import { NODE_SCHEMA } from './schema.js';

export class CompileError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'CompileError';
    this.line = line;
  }
}

const COMPARE_OPS = new Map([
  ['EQEQ', 'EQ'],
  ['NE', 'NE'],
  ['LT', 'LT'],
  ['LE', 'LE'],
  ['GT', 'GT'],
  ['GE', 'GE'],
]);

class Compiler {
  constructor() {
    this.code = [];
    this.scope = new Map();
    this.slots = 0;
  }

  compile(program) {
    for (const stmt of program.statements) {
      if (stmt.kind === 'let') this.compileLet(stmt);
      else this.compileQuery(stmt);
    }
    return { code: this.code, slots: this.slots };
  }

  compileLet(stmt) {
    if (this.scope.has(stmt.name)) {
      throw new CompileError(`variable '${stmt.name}' is already declared`, stmt.line);
    }
    const type = this.compileExpr(stmt.expr);
    const slot = this.slots++;
    this.scope.set(stmt.name, { slot, type });
    this.code.push({ op: 'STORE', slot });
  }

  compileQuery(stmt) {
    const type = this.compileExpr(stmt.expr);
    if (type !== 'set' && type !== 'path') {
      throw new CompileError(`query must yield a node set or a path, got '${type}'`, stmt.line);
    }
    if (stmt.filter) {
      if (type !== 'set') {
        throw new CompileError('a where clause requires a node set (shortestPath yields a path)', stmt.line);
      }
      const program = [];
      this.compileFilter(stmt.filter, program);
      this.code.push({ op: 'FILTER', program });
    }
    this.code.push({ op: 'EMIT', source: stmt.source, line: stmt.line });
  }

  compileExpr(expr) {
    switch (expr.kind) {
      case 'literal':
        this.code.push({ op: 'PUSH', value: { kind: expr.litKind, value: expr.value } });
        return expr.litKind;
      case 'var': {
        const binding = this.scope.get(expr.name);
        if (!binding) throw new CompileError(`undefined variable '${expr.name}'`, expr.line);
        this.code.push({ op: 'LOAD', slot: binding.slot });
        return binding.type;
      }
      case 'call': {
        const want = expr.fn === 'shortestPath' ? 2 : 1;
        if (expr.args.length !== want) {
          throw new CompileError(
            `${expr.fn} expects ${want} argument(s), got ${expr.args.length}`,
            expr.line,
          );
        }
        for (const arg of expr.args) {
          const type = this.compileExpr(arg);
          if (type !== 'lot') {
            throw new CompileError(`${expr.fn} arguments must be lot numbers, got '${type}'`, expr.line);
          }
        }
        this.code.push({ op: 'CALL', fn: expr.fn, argc: want });
        return expr.fn === 'shortestPath' ? 'path' : 'set';
      }
      default:
        throw new CompileError(`unsupported expression '${expr.kind}'`, expr.line ?? 0);
    }
  }

  compileFilter(node, out) {
    switch (node.kind) {
      case 'literal':
        out.push({ op: 'PUSH', value: { kind: node.litKind, value: node.value } });
        return;
      case 'name': {
        const binding = this.scope.get(node.name);
        if (binding) {
          out.push({ op: 'LOAD', slot: binding.slot });
        } else if (node.name in NODE_SCHEMA) {
          out.push({ op: 'ATTR', name: node.name });
        } else {
          throw new CompileError(`unknown attribute or variable '${node.name}'`, node.line);
        }
        return;
      }
      case 'unary':
        this.compileFilter(node.operand, out);
        out.push({ op: 'NOT' });
        return;
      case 'binary': {
        this.compileFilter(node.left, out);
        this.compileFilter(node.right, out);
        if (node.op === 'AND' || node.op === 'OR') {
          out.push({ op: node.op });
        } else {
          out.push({ op: COMPARE_OPS.get(node.op) });
        }
        return;
      }
      default:
        throw new CompileError(`unsupported filter node '${node.kind}'`, node.line ?? 0);
    }
  }
}

export function compile(program) {
  return new Compiler().compile(program);
}
