export class CompileError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'CompileError';
    this.line = line;
  }
}

// Instruction set (arrays: [opcode, ...operands]):
//   PUSH_CONST idx        push constants[idx]
//   LOAD_SLOT n / STORE_SLOT n   lexical variable slots
//   NODE_REF idx          push {kind:'ref', id} for a lot constant
//   ANCESTORS | DESCENDANTS      set/ref -> set
//   SHORTEST_PATH         ref, ref -> path
//   NODES                 -> set of all node ids
//   FILTER idx            set -> set, constants[idx] is a predicate sub-program
//   SORT keyIdx dir       set -> sorted set
//   EMIT                  append top of stack to output
// Predicate sub-program ops:
//   LOAD_PROP keyIdx | PUSH_CONST idx | EQ NE LT LE GT GE | AND OR NOT

const BUILTINS = new Set(['ancestors', 'descendants', 'shortestPath', 'nodes']);

class Compiler {
  constructor() {
    this.instructions = [];
    this.constants = [];
    this.scopes = [new Map()];
    this.slotCount = 0;
  }

  addConst(value) {
    this.constants.push(value);
    return this.constants.length - 1;
  }

  emit(...ins) { this.instructions.push(ins); }

  lookup(name, line) {
    for (let s = this.scopes.length - 1; s >= 0; s--) {
      if (this.scopes[s].has(name)) return this.scopes[s].get(name);
    }
    throw new CompileError(`undefined variable '${name}'`, line);
  }

  compileProgram(node) {
    for (const stmt of node.body) this.compileStatement(stmt);
    return { instructions: this.instructions, constants: this.constants };
  }

  compileStatement(stmt) {
    if (stmt.type === 'let') {
      this.compileSource(stmt.value);
      const slot = this.slotCount++;
      this.scopes[this.scopes.length - 1].set(stmt.name, slot);
      this.emit('STORE_SLOT', slot);
    } else if (stmt.type === 'block') {
      this.scopes.push(new Map());
      for (const inner of stmt.body) this.compileStatement(inner);
      this.scopes.pop();
    } else if (stmt.type === 'select') {
      this.compileSource(stmt.source);
      if (stmt.where) {
        const pred = { instructions: [], constants: this.constants };
        this.compilePredicate(stmt.where, pred.instructions);
        this.emit('FILTER', this.addConst(pred.instructions));
      }
      const orderBy = stmt.orderBy ?? { key: 'id', dir: 'asc' };
      this.emit('SORT', this.addConst(orderBy.key), orderBy.dir);
      this.emit('EMIT');
    } else {
      throw new CompileError(`unknown statement ${stmt.type}`);
    }
  }

  compileSource(node) {
    if (node.type === 'lot' || node.type === 'string') {
      this.emit('NODE_REF', this.addConst(node.value));
    } else if (node.type === 'var') {
      this.emit('LOAD_SLOT', this.lookup(node.name, node.line));
    } else if (node.type === 'call') {
      if (!BUILTINS.has(node.name)) {
        throw new CompileError(`unknown function '${node.name}'`, node.line);
      }
      const arity = { ancestors: 1, descendants: 1, shortestPath: 2, nodes: 0 }[node.name];
      if (node.args.length !== arity) {
        throw new CompileError(`${node.name} expects ${arity} argument(s), got ${node.args.length}`, node.line);
      }
      for (const arg of node.args) this.compileSource(arg);
      this.emit({ ancestors: 'ANCESTORS', descendants: 'DESCENDANTS',
                  shortestPath: 'SHORTEST_PATH', nodes: 'NODES' }[node.name]);
    } else {
      throw new CompileError(`invalid source expression`, node.line);
    }
  }

  compilePredicate(expr, out) {
    if (expr.type === 'const') {
      out.push(['PUSH_CONST', this.addConst(expr.value)]);
    } else if (expr.type === 'prop') {
      out.push(['LOAD_PROP', this.addConst(expr.name)]);
    } else if (expr.type === 'binary') {
      this.compilePredicate(expr.left, out);
      this.compilePredicate(expr.right, out);
      out.push([{ '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE',
                  '>': 'GT', '>=': 'GE', and: 'AND', or: 'OR' }[expr.op]]);
    } else if (expr.type === 'not') {
      this.compilePredicate(expr.operand, out);
      out.push(['NOT']);
    } else {
      throw new CompileError(`invalid filter expression`, expr.line);
    }
  }
}

export function compile(ast) {
  return new Compiler().compileProgram(ast);
}
