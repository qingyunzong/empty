import { createHash } from 'node:crypto';

export type Instruction =
  | { op: 'LOADI'; reg: number; imm: number }
  | { op: 'LOAD'; reg: number; addr: number }
  | { op: 'STORE'; addr: number; reg: number }
  | { op: 'MOV'; dst: number; src: number }
  | { op: 'ADD'; reg: number; src: number }
  | { op: 'ADDI'; reg: number; imm: number }
  | { op: 'SUB'; reg: number; src: number }
  | { op: 'MUL'; reg: number; src: number }
  | { op: 'JMP'; target: number }
  | { op: 'JZ'; reg: number; target: number }
  | { op: 'IN'; reg: number }
  | { op: 'OUT'; reg: number }
  | { op: 'HALT' };

export interface VmOptions {
  registerCount?: number;
  heapSize?: number;
}

/** Full observable machine state. Everything needed to resume execution. */
export interface VmState {
  registers: number[];
  heap: number[];
  pc: number;
  halted: boolean;
  output: number[];
  inputsConsumed: number;
}

export function cloneState(state: VmState): VmState {
  return {
    registers: state.registers.slice(),
    heap: state.heap.slice(),
    pc: state.pc,
    halted: state.halted,
    output: state.output.slice(),
    inputsConsumed: state.inputsConsumed,
  };
}

/** Deterministic digest of a full state snapshot. */
export function hashState(state: VmState): string {
  const canonical = JSON.stringify({
    r: state.registers,
    h: state.heap,
    p: state.pc,
    t: state.halted ? 1 : 0,
    o: state.output,
    i: state.inputsConsumed,
  });
  return createHash('sha1').update(canonical).digest('hex');
}

export function disassemble(ins: Instruction): string {
  switch (ins.op) {
    case 'LOADI': return `LOADI R${ins.reg}, ${ins.imm}`;
    case 'LOAD': return `LOAD R${ins.reg}, [${ins.addr}]`;
    case 'STORE': return `STORE [${ins.addr}], R${ins.reg}`;
    case 'MOV': return `MOV R${ins.dst}, R${ins.src}`;
    case 'ADD': return `ADD R${ins.reg}, R${ins.src}`;
    case 'ADDI': return `ADDI R${ins.reg}, ${ins.imm}`;
    case 'SUB': return `SUB R${ins.reg}, R${ins.src}`;
    case 'MUL': return `MUL R${ins.reg}, R${ins.src}`;
    case 'JMP': return `JMP ${ins.target}`;
    case 'JZ': return `JZ R${ins.reg}, ${ins.target}`;
    case 'IN': return `IN R${ins.reg}`;
    case 'OUT': return `OUT R${ins.reg}`;
    case 'HALT': return 'HALT';
  }
}

export class NeedInputError extends Error {
  constructor() {
    super('VM is waiting for an external input');
    this.name = 'NeedInputError';
  }
}

export interface StepInfo {
  pc: number;
  instruction: Instruction;
  inputUsed: number | null;
}

export class VM {
  readonly program: Instruction[];
  readonly registerCount: number;
  readonly heapSize: number;

  registers: number[];
  heap: number[];
  pc = 0;
  halted = false;
  output: number[] = [];
  inputsConsumed = 0;
  private inputQueue: number[] = [];

  constructor(program: Instruction[], options: VmOptions = {}) {
    this.program = program;
    this.registerCount = options.registerCount ?? 8;
    this.heapSize = options.heapSize ?? 64;
    this.registers = new Array(this.registerCount).fill(0);
    this.heap = new Array(this.heapSize).fill(0);
  }

  peek(): Instruction | undefined {
    return this.program[this.pc];
  }

  get queuedInputs(): number {
    return this.inputQueue.length;
  }

  queueInput(value: number): void {
    this.inputQueue.push(value);
  }

  private checkReg(index: number): void {
    if (index < 0 || index >= this.registerCount) {
      throw new RangeError(`register out of range: R${index}`);
    }
  }

  private checkAddr(addr: number): void {
    if (addr < 0 || addr >= this.heapSize) {
      throw new RangeError(`heap address out of range: ${addr}`);
    }
  }

  step(): StepInfo {
    if (this.halted) throw new Error('VM is halted');
    const pc = this.pc;
    const ins = this.program[pc];
    if (ins === undefined) throw new RangeError(`pc out of range: ${pc}`);

    let inputUsed: number | null = null;
    switch (ins.op) {
      case 'LOADI':
        this.checkReg(ins.reg);
        this.registers[ins.reg] = ins.imm;
        this.pc += 1;
        break;
      case 'LOAD':
        this.checkReg(ins.reg);
        this.checkAddr(ins.addr);
        this.registers[ins.reg] = this.heap[ins.addr];
        this.pc += 1;
        break;
      case 'STORE':
        this.checkReg(ins.reg);
        this.checkAddr(ins.addr);
        this.heap[ins.addr] = this.registers[ins.reg];
        this.pc += 1;
        break;
      case 'MOV':
        this.checkReg(ins.dst);
        this.checkReg(ins.src);
        this.registers[ins.dst] = this.registers[ins.src];
        this.pc += 1;
        break;
      case 'ADD':
        this.checkReg(ins.reg);
        this.checkReg(ins.src);
        this.registers[ins.reg] += this.registers[ins.src];
        this.pc += 1;
        break;
      case 'ADDI':
        this.checkReg(ins.reg);
        this.registers[ins.reg] += ins.imm;
        this.pc += 1;
        break;
      case 'SUB':
        this.checkReg(ins.reg);
        this.checkReg(ins.src);
        this.registers[ins.reg] -= this.registers[ins.src];
        this.pc += 1;
        break;
      case 'MUL':
        this.checkReg(ins.reg);
        this.checkReg(ins.src);
        this.registers[ins.reg] *= this.registers[ins.src];
        this.pc += 1;
        break;
      case 'JMP':
        this.pc = ins.target;
        break;
      case 'JZ':
        this.checkReg(ins.reg);
        this.pc = this.registers[ins.reg] === 0 ? ins.target : this.pc + 1;
        break;
      case 'IN': {
        this.checkReg(ins.reg);
        const value = this.inputQueue.shift();
        if (value === undefined) throw new NeedInputError();
        inputUsed = value;
        this.registers[ins.reg] = value;
        this.inputsConsumed += 1;
        this.pc += 1;
        break;
      }
      case 'OUT':
        this.checkReg(ins.reg);
        this.output.push(this.registers[ins.reg]);
        this.pc += 1;
        break;
      case 'HALT':
        this.halted = true;
        break;
    }
    return { pc, instruction: ins, inputUsed };
  }

  snapshot(): VmState {
    return cloneState(this);
  }

  restore(state: VmState): void {
    this.registers = state.registers.slice();
    this.heap = state.heap.slice();
    this.pc = state.pc;
    this.halted = state.halted;
    this.output = state.output.slice();
    this.inputsConsumed = state.inputsConsumed;
    this.inputQueue = [];
  }
}
