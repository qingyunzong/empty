// Compiles a type-checked rule AST into stack-machine bytecode.
//
// Opcodes:
//   PUSH <constIdx>     push a constant
//   LOAD <slot>         push a local (param / const / let slot)
//   STORE <slot>        pop into a local
//   NEG NOT             unary operators
//   ADD SUB MUL DIV     arithmetic (ratios are exact fractions)
//   LT LE GT GE EQ NE   comparisons
//   JMP <pc>            unconditional jump
//   JMP_IF_FALSE <pc>   pop; jump when false
//   JMP_IF_TRUE <pc>    pop; jump when true
//   VERDICT <0|1|2>     halt with ACCEPT / REJECT / CONTINUE
//   HALT                halt; VM maps this to CONTINUE (legal pending state)

export const VERDICT_CODES = { ACCEPT: 0, REJECT: 1, CONTINUE: 2 };

const BIN_OP = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE', '==': 'EQ', '!=': 'NE',
};

class Env {
  constructor(parent) {
    this.parent = parent;
    this.slots = new Map();
  }

  lookup(name) {
    for (let env = this; env; env = env.parent) {
      if (env.slots.has(name)) return env.slots.get(name);
    }
    return null;
  }
}

export function compile(rule) {
  const consts = [];
  const code = [];
  const emit = (op, arg) => {
    code.push(arg === undefined ? { op } : { op, arg });
    return code.length - 1;
  };
  const patch = (at, target) => {
    code[at].arg = target;
  };
  const addConst = (value) => {
    consts.push(value);
    return consts.length - 1;
  };

  const trueConst = addConst({ kind: 'bool', value: true });
  const falseConst = addConst({ kind: 'bool', value: false });

  let nextSlot = 0;
  const globalEnv = new Env(null);
  const params = rule.params.map((p) => ({ name: p.name, type: p.type, slot: nextSlot++ }));
  for (const p of params) globalEnv.slots.set(p.name, p.slot);

  function emitExpr(node, env) {
    switch (node.kind) {
      case 'lit':
        emit('PUSH', addConst({ kind: node.litType, value: node.value }));
        return;
      case 'ident': {
        const slot = env.lookup(node.name);
        emit('LOAD', slot);
        return;
      }
      case 'un':
        emitExpr(node.expr, env);
        emit(node.op === 'not' ? 'NOT' : 'NEG');
        return;
      case 'bin': {
        if (node.op === 'and') {
          emitExpr(node.left, env);
          const jumpFalse = emit('JMP_IF_FALSE', 0);
          emitExpr(node.right, env);
          const jumpEnd = emit('JMP', 0);
          patch(jumpFalse, code.length);
          emit('PUSH', falseConst);
          patch(jumpEnd, code.length);
          return;
        }
        if (node.op === 'or') {
          emitExpr(node.left, env);
          const jumpTrue = emit('JMP_IF_TRUE', 0);
          emitExpr(node.right, env);
          const jumpEnd = emit('JMP', 0);
          patch(jumpTrue, code.length);
          emit('PUSH', trueConst);
          patch(jumpEnd, code.length);
          return;
        }
        emitExpr(node.left, env);
        emitExpr(node.right, env);
        emit(BIN_OP[node.op]);
        return;
      }
      default:
        throw new Error(`internal: cannot compile node kind '${node.kind}'`);
    }
  }

  // consts become prefix code evaluated once per run.
  for (const c of rule.consts) {
    emitExpr(c.expr, globalEnv);
    const slot = nextSlot++;
    emit('STORE', slot);
    globalEnv.slots.set(c.name, slot);
  }

  for (const clause of rule.clauses) {
    const clauseEnv = new Env(globalEnv);
    for (const binding of clause.lets) {
      emitExpr(binding.expr, clauseEnv);
      const slot = nextSlot++;
      emit('STORE', slot);
      clauseEnv.slots.set(binding.name, slot);
    }
    emitExpr(clause.cond, clauseEnv);
    const jumpNext = emit('JMP_IF_FALSE', 0);
    emit('VERDICT', VERDICT_CODES[clause.verdict]);
    patch(jumpNext, code.length);
  }

  if (rule.otherwise) {
    emit('VERDICT', VERDICT_CODES[rule.otherwise.verdict]);
  }
  emit('HALT');

  return {
    name: rule.name,
    ruleVersion: rule.ruleVersion,
    params,
    slotCount: nextSlot,
    consts,
    code,
  };
}
