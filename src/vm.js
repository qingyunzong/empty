// Stack-based bytecode interpreter with transactional rollback.

import { literalType } from './lang.js';

export class VmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VmError';
  }
}

const NUMERIC = new Set(['int', 'float']);

function isNumeric(value) {
  return NUMERIC.has(value.type);
}

function requireNumericValue(value, op) {
  if (!isNumeric(value)) {
    throw new VmError(`runtime type mismatch: ${op} expects numeric operands, got ${value.type}`);
  }
}

function requireBoolValue(value, op) {
  if (value.type !== 'bool') {
    throw new VmError(`runtime type mismatch: ${op} expects bool, got ${value.type}`);
  }
}

// Executes one transaction's instruction slice.
// hooks: { counter, crashAt, onCrash, onCommit }
export function execute(code, observations, hooks = {}) {
  const regs = new Map(
    Object.entries(observations).map(([name, obs]) => [name, { type: obs.type, value: obs.value }]),
  );
  const stack = [];
  const touched = new Map();
  let currentTx = null;
  const counter = hooks.counter ?? { executed: 0 };
  const crashAt = hooks.crashAt ?? 0;

  const snapshot = () =>
    Object.fromEntries([...regs].map(([name, reg]) => [name, { ...reg }]));

  const rollback = () => {
    for (const [name, old] of touched) regs.set(name, old);
    touched.clear();
  };

  const pop = () => {
    if (stack.length === 0) throw new VmError('stack underflow');
    return stack.pop();
  };

  const popBinary = (op) => {
    const right = pop();
    const left = pop();
    requireNumericValue(left, op);
    requireNumericValue(right, op);
    return [left, right];
  };

  const numericResult = (left, right, value) => ({
    type: left.type === 'float' || right.type === 'float' ? 'float' : 'int',
    value,
  });

  const step = (ins) => {
    switch (ins.op) {
      case 'BEGIN_TX':
        currentTx = ins.name;
        touched.clear();
        break;
      case 'COMMIT':
        if (hooks.onCommit) hooks.onCommit(ins.name, snapshot());
        touched.clear();
        currentTx = null;
        break;
      case 'PUSH':
        stack.push({ type: literalType(ins.value), value: typeof ins.value === 'object' ? ins.value.evidence : ins.value });
        break;
      case 'LOAD': {
        const reg = regs.get(ins.name);
        if (!reg) throw new VmError(`unknown observation "${ins.name}"`);
        stack.push({ ...reg });
        break;
      }
      case 'STORE': {
        const value = pop();
        const reg = regs.get(ins.name);
        if (!reg) throw new VmError(`unknown observation "${ins.name}"`);
        let stored = value;
        if (value.type !== reg.type) {
          if (value.type === 'int' && reg.type === 'float') {
            stored = { type: 'float', value: value.value };
          } else {
            throw new VmError(
              `runtime type mismatch: cannot bind ${value.type} to ${reg.type} field "${ins.name}"`,
            );
          }
        }
        if (!touched.has(ins.name)) touched.set(ins.name, { ...reg });
        regs.set(ins.name, stored);
        break;
      }
      case 'ADD': {
        const [left, right] = popBinary('ADD');
        stack.push(numericResult(left, right, left.value + right.value));
        break;
      }
      case 'SUB': {
        const [left, right] = popBinary('SUB');
        stack.push(numericResult(left, right, left.value - right.value));
        break;
      }
      case 'MUL': {
        const [left, right] = popBinary('MUL');
        stack.push(numericResult(left, right, left.value * right.value));
        break;
      }
      case 'DIV': {
        const [left, right] = popBinary('DIV');
        if (right.value === 0) throw new VmError('division by zero');
        const value =
          left.type === 'int' && right.type === 'int'
            ? Math.trunc(left.value / right.value)
            : left.value / right.value;
        stack.push(numericResult(left, right, value));
        break;
      }
      case 'MOD': {
        const right = pop();
        const left = pop();
        if (left.type !== 'int' || right.type !== 'int') {
          throw new VmError('runtime type mismatch: MOD expects int operands');
        }
        if (right.value === 0) throw new VmError('division by zero');
        stack.push({ type: 'int', value: left.value % right.value });
        break;
      }
      case 'NEG': {
        const value = pop();
        requireNumericValue(value, 'NEG');
        stack.push({ type: value.type, value: -value.value });
        break;
      }
      case 'LT':
      case 'LE':
      case 'GT':
      case 'GE': {
        const [left, right] = popBinary(ins.op);
        const ops = { LT: (a, b) => a < b, LE: (a, b) => a <= b, GT: (a, b) => a > b, GE: (a, b) => a >= b };
        stack.push({ type: 'bool', value: ops[ins.op](left.value, right.value) });
        break;
      }
      case 'EQ':
      case 'NE': {
        const right = pop();
        const left = pop();
        const comparable =
          left.type === right.type || (isNumeric(left) && isNumeric(right));
        if (!comparable) {
          throw new VmError(
            `runtime type mismatch: cannot compare ${left.type} with ${right.type}`,
          );
        }
        const equal = left.value === right.value;
        stack.push({ type: 'bool', value: ins.op === 'EQ' ? equal : !equal });
        break;
      }
      case 'AND':
      case 'OR': {
        const right = pop();
        const left = pop();
        requireBoolValue(left, ins.op);
        requireBoolValue(right, ins.op);
        stack.push({
          type: 'bool',
          value: ins.op === 'AND' ? left.value && right.value : left.value || right.value,
        });
        break;
      }
      case 'NOT': {
        const value = pop();
        requireBoolValue(value, 'NOT');
        stack.push({ type: 'bool', value: !value.value });
        break;
      }
      case 'GUARD': {
        const value = pop();
        if (value.type !== 'bool') {
          throw new VmError(`runtime type mismatch: guard is ${value.type}, not bool`);
        }
        if (!value.value) {
          throw new VmError(`guard failed in transaction "${currentTx}"`);
        }
        break;
      }
      default:
        throw new VmError(`unknown instruction ${ins.op}`);
    }
  };

  try {
    for (const ins of code) {
      step(ins);
      counter.executed += 1;
      if (crashAt && counter.executed === crashAt && hooks.onCrash) {
        hooks.onCrash(counter.executed);
      }
    }
  } catch (err) {
    rollback();
    throw err;
  }
  return snapshot();
}
