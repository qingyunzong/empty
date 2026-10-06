import { CompileError } from './errors.js';
import { parse } from './parser.js';
import { check, LEVEL_ORDER } from './checker.js';
import { hashObject } from './hash.js';

export const DECISIONS = ['ACCEPT', 'REJECT', 'CONTINUE'];

const TYPE_TAG = { quantity: 'q', ratio: 'r', defect_level: 'l', boolean: 'b' };

class Compiler {
  constructor(rule) {
    this.rule = rule;
    this.code = [];
    this.constants = [];
    this.constIndex = new Map();
  }

  emit(op, a = null, b = null) {
    this.code.push(b === null ? (a === null ? [op] : [op, a]) : [op, a, b]);
    return this.code.length - 1;
  }

  pushConst(type, value) {
    const tag = TYPE_TAG[type];
    const key = `${tag}:${value}`;
    let idx = this.constIndex.get(key);
    if (idx === undefined) {
      idx = this.constants.length;
      this.constants.push({ t: tag, v: value });
      this.constIndex.set(key, idx);
    }
    this.emit('PUSH', idx);
  }

  expr(node) {
    switch (node.kind) {
      case 'num': this.pushConst('quantity', node.value); return;
      case 'percent': this.pushConst('ratio', node.value); return;
      case 'level': this.pushConst('defect_level', LEVEL_ORDER[node.value]); return;
      case 'ident': this.emit('LOAD', node.slot); return;
      case 'neg':
        this.expr(node.expr);
        this.emit('NEG');
        return;
      case 'not':
        this.expr(node.expr);
        this.emit('NOT');
        return;
      case 'call': {
        for (const arg of node.args) this.expr(arg);
        this.emit('CALL', node.name, node.args.length);
        return;
      }
      case 'bin': {
        this.expr(node.left);
        this.expr(node.right);
        const op = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
          '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE', '==': 'EQ', '!=': 'NE',
          'and': 'AND', 'or': 'OR' }[node.op];
        if (!op) throw new CompileError(`internal: unsupported operator '${node.op}'`, { line: node.line });
        this.emit(op);
        return;
      }
      default:
        throw new CompileError(`internal: cannot compile '${node.kind}'`, { line: node.line });
    }
  }

  letStmt(stmt) {
    this.expr(stmt.expr);
    this.emit('STORE', stmt.slot);
  }

  compile() {
    const rule = this.rule;
    for (const stmt of rule.lets) this.letStmt(stmt);
    for (const stmt of rule.decide.lets) this.letStmt(stmt);
    for (const w of rule.decide.whens) {
      this.expr(w.guard);
      const jif = this.emit('JIF', 0);
      this.emit('EMIT', DECISIONS.indexOf(w.decision));
      this.code[jif][1] = this.code.length;
    }
    this.emit('EMIT', DECISIONS.indexOf(rule.decide.otherwise.decision));
    return {
      format: 'qcert-bc/1',
      meta: {
        name: rule.name,
        version: rule.version,
        effective: rule.effective,
        batch: rule.batch,
      },
      params: rule.__params,
      slots: rule.__slots,
      constants: this.constants,
      code: this.code,
    };
  }
}

// Full pipeline: source -> AST -> type check -> bytecode program.
export function compileRule(source) {
  const rule = parse(source);
  const { params, slots } = check(rule);
  rule.__params = params;
  rule.__slots = slots;
  const program = new Compiler(rule).compile();
  program.rule_hash = hashObject({ source });
  return program;
}
