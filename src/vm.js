'use strict';

// Stack-machine interpreter with transactional rollback.
// Values are { t: 'int'|'float'|'bool'|'evidence', v }.
// `registers` (Map name -> value) is mutated in place; committed state is
// reported through onCommit so the caller can persist it atomically.

const { isNumeric } = require('./types');

class TxnAbort extends Error {}

function runProgram(instructions, registers, fieldTypes, options = {}) {
  const committed = options.committedSeqs || new Set();
  const crashAt = options.crashAt ?? null;
  const onCommit = options.onCommit || (() => {});
  const onCrash = options.onCrash || (() => {});

  const commitOf = new Map();
  for (let i = 0; i < instructions.length; i++) {
    if (instructions[i].op === 'TXN_BEGIN') {
      for (let j = i + 1; j < instructions.length; j++) {
        if (instructions[j].op === 'TXN_COMMIT') {
          commitOf.set(i, j);
          break;
        }
      }
    }
  }

  const stack = [];
  const rolledBack = [];
  const committedNow = [];
  let txn = null; // { seq, beginIndex, undo: Map }
  let executed = 0;
  let pc = 0;

  function abort(reason) {
    throw new TxnAbort(reason);
  }

  function pop() {
    if (stack.length === 0) abort('stack underflow');
    return stack.pop();
  }

  function popNumeric(op) {
    const b = pop();
    const a = pop();
    if (!isNumeric(a.t) || !isNumeric(b.t)) {
      abort(`${op} on non-numeric value (${a.t}, ${b.t})`);
    }
    return [a, b];
  }

  function popBool(op) {
    const b = pop();
    const a = pop();
    if (a.t !== 'bool' || b.t !== 'bool') {
      abort(`${op} on non-bool value (${a.t}, ${b.t})`);
    }
    return [a, b];
  }

  function execute(ins) {
    switch (ins.op) {
      case 'TXN_BEGIN':
        txn = { seq: ins.arg, beginIndex: pc, undo: new Map() };
        break;
      case 'TXN_COMMIT':
        committedNow.push(txn.seq);
        txn = null;
        onCommit(ins.arg);
        break;
      case 'PUSH_INT':
        stack.push({ t: 'int', v: ins.arg });
        break;
      case 'PUSH_FLOAT':
        stack.push({ t: 'float', v: ins.arg });
        break;
      case 'PUSH_BOOL':
        stack.push({ t: 'bool', v: ins.arg });
        break;
      case 'PUSH_EV':
        stack.push({ t: 'evidence', v: ins.arg });
        break;
      case 'LOAD': {
        const v = registers.get(ins.arg);
        if (!v) abort(`load of unknown register ${ins.arg}`);
        stack.push({ t: v.t, v: v.v });
        break;
      }
      case 'STORE': {
        const val = pop();
        const ft = fieldTypes.get(ins.arg);
        let stored = val;
        if (ft === 'float' && val.t === 'int') {
          stored = { t: 'float', v: val.v };
        } else if (ft !== val.t) {
          abort(`type mismatch on store to ${ins.arg}: field is ${ft}, value is ${val.t}`);
        }
        if (txn && !txn.undo.has(ins.arg)) {
          txn.undo.set(ins.arg, registers.get(ins.arg));
        }
        registers.set(ins.arg, stored);
        break;
      }
      case 'ADD':
      case 'SUB':
      case 'MUL':
      case 'DIV':
      case 'MOD': {
        const [a, b] = popNumeric(ins.op);
        if (ins.op === 'MOD' && (a.t !== 'int' || b.t !== 'int')) {
          abort('MOD requires int operands');
        }
        if ((ins.op === 'DIV' || ins.op === 'MOD') && b.v === 0) {
          abort('division by zero');
        }
        const floatResult = a.t === 'float' || b.t === 'float';
        let v;
        if (ins.op === 'ADD') v = a.v + b.v;
        else if (ins.op === 'SUB') v = a.v - b.v;
        else if (ins.op === 'MUL') v = a.v * b.v;
        else if (ins.op === 'DIV') v = floatResult ? a.v / b.v : Math.trunc(a.v / b.v);
        else v = a.v % b.v;
        stack.push({ t: floatResult && ins.op !== 'MOD' ? 'float' : 'int', v });
        break;
      }
      case 'LT':
      case 'LE':
      case 'GT':
      case 'GE': {
        const [a, b] = popNumeric(ins.op);
        let v;
        if (ins.op === 'LT') v = a.v < b.v;
        else if (ins.op === 'LE') v = a.v <= b.v;
        else if (ins.op === 'GT') v = a.v > b.v;
        else v = a.v >= b.v;
        stack.push({ t: 'bool', v });
        break;
      }
      case 'EQ':
      case 'NE': {
        const b = pop();
        const a = pop();
        let eq;
        if (isNumeric(a.t) && isNumeric(b.t)) eq = a.v === b.v;
        else if (a.t === b.t) eq = a.v === b.v;
        else abort(`cannot compare ${a.t} with ${b.t}`);
        stack.push({ t: 'bool', v: ins.op === 'EQ' ? eq : !eq });
        break;
      }
      case 'AND': {
        const [a, b] = popBool('AND');
        stack.push({ t: 'bool', v: a.v && b.v });
        break;
      }
      case 'OR': {
        const [a, b] = popBool('OR');
        stack.push({ t: 'bool', v: a.v || b.v });
        break;
      }
      case 'NOT': {
        const a = pop();
        if (a.t !== 'bool') abort('NOT on non-bool value');
        stack.push({ t: 'bool', v: !a.v });
        break;
      }
      case 'NEG': {
        const a = pop();
        if (!isNumeric(a.t)) abort('NEG on non-numeric value');
        stack.push({ t: a.t, v: -a.v });
        break;
      }
      case 'GUARD': {
        const v = pop();
        if (v.t !== 'bool') abort('guard did not evaluate to bool');
        if (!v.v) abort('guard failed');
        break;
      }
      default:
        throw new Error(`unknown opcode: ${ins.op}`);
    }
  }

  while (pc < instructions.length) {
    const ins = instructions[pc];
    if (ins.op === 'TXN_BEGIN' && committed.has(ins.arg)) {
      pc = commitOf.get(pc) + 1;
      continue;
    }
    executed++;
    try {
      execute(ins);
    } catch (e) {
      if (e instanceof TxnAbort) {
        for (const [name, old] of txn.undo) registers.set(name, old);
        rolledBack.push({ seq: txn.seq, reason: e.message });
        stack.length = 0;
        pc = commitOf.get(txn.beginIndex) + 1;
        txn = null;
        continue;
      }
      throw e;
    }
    if (crashAt !== null && executed === crashAt) {
      onCrash(executed);
    }
    pc++;
  }

  return { rolledBack, committed: committedNow };
}

module.exports = { runProgram, TxnAbort };
