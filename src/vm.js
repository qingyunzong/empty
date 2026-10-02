// Stack-based bytecode VM. Executes the compiled correction program against
// a single record. Out-of-range clamp values are corrected (clamped), not
// errors. Missing fields, division by zero and type errors raise VMError,
// which the batch runner treats as a batch-fatal failure.

export class VMError extends Error {
  constructor(message, { pc = null, recordIndex = null } = {}) {
    super(message);
    this.name = 'VMError';
    this.pc = pc;
    this.recordIndex = recordIndex;
  }
}

export class CrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrashError';
  }
}

const CMP_OPS = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

export function execute(code, record, { counter = { count: 0 }, crashAfter = null, recordIndex = null } = {}) {
  const stack = [];
  let pc = 0;
  const fail = (message) => { throw new VMError(message, { pc, recordIndex }); };
  const popNumber = (op) => {
    const value = stack.pop();
    if (typeof value !== 'number' || Number.isNaN(value)) {
      fail(`operand of ${op} is not a number`);
    }
    return value;
  };

  while (pc < code.length) {
    const instr = code[pc];
    counter.count++;
    if (crashAfter !== null && counter.count === crashAfter) {
      throw new CrashError(`simulated crash after bytecode instruction #${crashAfter} (record ${recordIndex})`);
    }
    let nextPc = pc + 1;
    switch (instr.op) {
      case 'PUSH':
        stack.push(instr.value);
        break;
      case 'LOAD':
        if (!(instr.field in record)) fail(`missing field "${instr.field}"`);
        stack.push(record[instr.field]);
        break;
      case 'STORE':
        if (stack.length === 0) fail('stack underflow on STORE');
        record[instr.field] = stack.pop();
        break;
      case 'CLAMP': {
        if (!(instr.field in record)) fail(`missing field "${instr.field}"`);
        const value = record[instr.field];
        if (typeof value !== 'number' || Number.isNaN(value)) fail(`clamp field "${instr.field}" is not a number`);
        record[instr.field] = Math.min(Math.max(value, instr.min), instr.max);
        break;
      }
      case 'ADD': {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) fail('stack underflow on ADD');
        stack.push(a + b);
        break;
      }
      case 'SUB': {
        const b = popNumber('SUB');
        const a = popNumber('SUB');
        stack.push(a - b);
        break;
      }
      case 'MUL': {
        const b = popNumber('MUL');
        const a = popNumber('MUL');
        stack.push(a * b);
        break;
      }
      case 'DIV': {
        const b = popNumber('DIV');
        const a = popNumber('DIV');
        if (b === 0) fail('division by zero');
        stack.push(a / b);
        break;
      }
      case 'NEG':
        stack.push(-popNumber('NEG'));
        break;
      case 'CMP': {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) fail('stack underflow on CMP');
        stack.push(CMP_OPS[instr.cmp](a, b));
        break;
      }
      case 'JZ':
        if (stack.length === 0) fail('stack underflow on JZ');
        if (!stack.pop()) nextPc = instr.target;
        break;
      case 'JMP':
        nextPc = instr.target;
        break;
      case 'DROP':
        return { record, dropped: true, instructions: counter.count };
      case 'HALT':
        return { record, dropped: false, instructions: counter.count };
      default:
        fail(`unknown opcode "${instr.op}"`);
    }
    pc = nextPc;
  }
  return { record, dropped: false, instructions: counter.count };
}
