import { sha256Hex } from './hash.js';

// Custom bytecode. Each instruction is [op, a, b]; a parallel `locs` array
// holds [line, col] per instruction for runtime error reporting.
export const OP = {
  PUSH_CONST: 0,    // a = const index
  LOAD_GLOBAL: 1,   // a = global slot
  LOAD_LOCAL: 2,    // a = local slot
  STORE_GLOBAL: 3,  // a = global slot
  STORE_LOCAL: 4,   // a = local slot
  ADD: 5, SUB: 6, MUL: 7, DIV: 8, NEG: 9, NOT: 10,
  EQ: 11, NE: 12, LT: 13, LE: 14, GT: 15, GE: 16,
  JMP: 17,          // a = target ip
  JMP_IF_FALSE: 18, // a = target ip
  JMP_IF_TRUE: 19,  // a = target ip
  CALL: 20,         // a = rule index, b = argc
  RET: 21,
};

const BINARY_OP = {
  '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV,
  '==': OP.EQ, '!=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE,
};

class CodeGen {
  constructor() {
    this.code = [];
    this.locs = [];
    this.consts = [];
    this.constIndex = new Map();
  }
  emit(op, a, b, node) {
    this.code.push(b === undefined ? [op, a] : [op, a, b]);
    this.locs.push([node ? node.line : null, node ? node.col : null]);
    return this.code.length - 1;
  }
  patch(index, target) {
    this.code[index][1] = target;
  }
  addConst(entry) {
    const key = JSON.stringify(entry);
    if (this.constIndex.has(key)) return this.constIndex.get(key);
    const idx = this.consts.length;
    this.consts.push(entry);
    this.constIndex.set(key, idx);
    return idx;
  }

  expr(node) {
    switch (node.type) {
      case 'moneyLit': this.emit(OP.PUSH_CONST, this.addConst({ t: 'm', v: node.value.toString() }), undefined, node); break;
      case 'rateLit': this.emit(OP.PUSH_CONST, this.addConst({ t: 'r', v: node.value.toString() }), undefined, node); break;
      case 'dateLit': this.emit(OP.PUSH_CONST, this.addConst({ t: 'd', v: node.value }), undefined, node); break;
      case 'boolLit': this.emit(OP.PUSH_CONST, this.addConst({ t: 'b', v: node.value }), undefined, node); break;
      case 'var':
        this.emit(node.resolved.kind === 'global' ? OP.LOAD_GLOBAL : OP.LOAD_LOCAL, node.resolved.slot, undefined, node);
        break;
      case 'unary':
        this.expr(node.operand);
        this.emit(node.op === 'not' ? OP.NOT : OP.NEG, undefined, undefined, node);
        break;
      case 'binary': this.binary(node); break;
      case 'if': {
        this.expr(node.cond);
        const jumpElse = this.emit(OP.JMP_IF_FALSE, 0, undefined, node);
        this.block(node.thenBlock);
        const jumpEnd = this.emit(OP.JMP, 0, undefined, node);
        this.patch(jumpElse, this.code.length);
        this.block(node.elseBlock);
        this.patch(jumpEnd, this.code.length);
        break;
      }
      case 'call': {
        for (const arg of node.args) this.expr(arg);
        this.emit(OP.CALL, node.ruleIndex, node.args.length, node);
        break;
      }
      default:
        throw new Error(`cannot compile node '${node.type}'`);
    }
  }

  binary(node) {
    if (node.op === 'and' || node.op === 'or') {
      // Short-circuit via jumps; result is always a materialized bool.
      const isAnd = node.op === 'and';
      this.expr(node.left);
      const jumpShortcut = this.emit(isAnd ? OP.JMP_IF_FALSE : OP.JMP_IF_TRUE, 0, undefined, node);
      this.expr(node.right);
      const jumpEnd = this.emit(OP.JMP, 0, undefined, node);
      this.patch(jumpShortcut, this.code.length);
      this.emit(OP.PUSH_CONST, this.addConst({ t: 'b', v: !isAnd }), undefined, node);
      this.patch(jumpEnd, this.code.length);
      return;
    }
    this.expr(node.left);
    this.expr(node.right);
    this.emit(BINARY_OP[node.op], undefined, undefined, node);
  }

  block(block) {
    for (const letDecl of block.lets) {
      this.expr(letDecl.expr);
      this.emit(OP.STORE_LOCAL, letDecl.slot, undefined, letDecl);
    }
    this.expr(block.expr);
  }
}

// Compile a checked program into a bytecode chunk:
//   { version, globals: [{name,type,slot,code,locs,consts,hash}],
//     rules:  [{name,params,returnType,nLocals,code,locs,consts,hash}] }
// `hash` is the sha256 of the declaration's source slice (provenance).
export function compile(program, src) {
  const chunk = { version: 1, globals: [], rules: [] };
  const ruleIndex = new Map();
  for (const decl of program.decls) {
    if (decl.type === 'ruleDecl') ruleIndex.set(decl.name, ruleIndex.size);
  }
  const annotateCalls = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'call') node.ruleIndex = ruleIndex.get(node.name);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(annotateCalls);
      else if (child && typeof child === 'object') annotateCalls(child);
    }
  };
  annotateCalls(program);

  for (const decl of program.decls) {
    if (decl.type !== 'paramDecl' && decl.type !== 'letDecl') continue;
    const gen = new CodeGen();
    gen.expr(decl.expr);
    gen.emit(OP.STORE_GLOBAL, decl.slot, undefined, decl);
    chunk.globals.push({
      name: decl.name, kind: decl.type === 'paramDecl' ? 'param' : 'let',
      type: decl.declaredType, slot: decl.slot,
      code: gen.code, locs: gen.locs, consts: gen.consts,
      hash: sha256Hex(src.slice(decl.start, decl.end)),
    });
  }

  for (const decl of program.decls) {
    if (decl.type !== 'ruleDecl') continue;
    const gen = new CodeGen();
    gen.block(decl.body);
    gen.emit(OP.RET, undefined, undefined, decl);
    chunk.rules.push({
      name: decl.name,
      params: decl.params.map((p) => ({ name: p.name, type: p.type })),
      returnType: decl.returnType,
      nLocals: decl.nLocals,
      code: gen.code, locs: gen.locs, consts: gen.consts,
      hash: sha256Hex(src.slice(decl.start, decl.end)),
    });
  }
  return chunk;
}
