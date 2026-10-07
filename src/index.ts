export type Instruction =
  | { op: 'push'; value: number }
  | { op: 'pop' }
  | { op: 'dup' }
  | { op: 'swap' }
  | { op: 'add' }
  | { op: 'sub' }
  | { op: 'mul' }
  | { op: 'div' }
  | { op: 'mod' }
  | { op: 'load'; addr: number }
  | { op: 'store'; addr: number }
  | { op: 'jmp'; target: number }
  | { op: 'jz'; target: number }
  | { op: 'call'; target: number }
  | { op: 'ret' }
  | { op: 'emit' }
  | { op: 'yield' }
  | { op: 'halt' };

export interface Snapshot {
  pc: number;
  stack: number[];
  callStack: number[];
  heap: Array<[number, number]>;
  output: number[];
  halted: boolean;
  yielded: boolean;
}

export type RunResult = 'halted' | 'yielded';

export class VmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VmError';
  }
}

export class VM {
  private pc = 0;
  private stack: number[] = [];
  private callStack: number[] = [];
  private heap = new Map<number, number>();
  private out: number[] = [];
  private haltedFlag = false;
  private yieldedFlag = false;

  constructor(public readonly program: readonly Instruction[]) {}

  get isHalted(): boolean {
    return this.haltedFlag;
  }

  get isYielded(): boolean {
    return this.yieldedFlag;
  }

  get output(): readonly number[] {
    return this.out;
  }

  snapshot(): Snapshot {
    return {
      pc: this.pc,
      stack: [...this.stack],
      callStack: [...this.callStack],
      heap: [...this.heap.entries()].map(([k, v]): [number, number] => [k, v]),
      output: [...this.out],
      halted: this.haltedFlag,
      yielded: this.yieldedFlag,
    };
  }

  static restore(program: readonly Instruction[], snap: Snapshot): VM {
    const vm = new VM(program);
    vm.pc = snap.pc;
    vm.stack = [...snap.stack];
    vm.callStack = [...snap.callStack];
    vm.heap = new Map(snap.heap);
    vm.out = [...snap.output];
    vm.haltedFlag = snap.halted;
    vm.yieldedFlag = snap.yielded;
    return vm;
  }

  run(): RunResult {
    this.yieldedFlag = false;
    while (!this.haltedFlag && !this.yieldedFlag) {
      this.step();
    }
    return this.haltedFlag ? 'halted' : 'yielded';
  }

  runToCompletion(): readonly number[] {
    while (this.run() === 'yielded') {
      // resume after each yield
    }
    return this.out;
  }

  step(): void {
    if (this.haltedFlag) {
      throw new VmError('cannot step a halted VM');
    }
    if (this.pc < 0 || this.pc >= this.program.length) {
      throw new VmError(`instruction pointer out of bounds: ${this.pc}`);
    }
    this.yieldedFlag = false;
    const instr = this.program[this.pc];
    switch (instr.op) {
      case 'push':
        this.stack.push(instr.value);
        this.pc += 1;
        break;
      case 'pop':
        this.requireStack(1, instr.op);
        this.stack.pop();
        this.pc += 1;
        break;
      case 'dup':
        this.requireStack(1, instr.op);
        this.stack.push(this.stack[this.stack.length - 1]);
        this.pc += 1;
        break;
      case 'swap': {
        this.requireStack(2, instr.op);
        const top = this.stack.length - 1;
        const tmp = this.stack[top];
        this.stack[top] = this.stack[top - 1];
        this.stack[top - 1] = tmp;
        this.pc += 1;
        break;
      }
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'mod': {
        this.requireStack(2, instr.op);
        const b = this.stack[this.stack.length - 1];
        const a = this.stack[this.stack.length - 2];
        let result: number;
        switch (instr.op) {
          case 'add':
            result = a + b;
            break;
          case 'sub':
            result = a - b;
            break;
          case 'mul':
            result = a * b;
            break;
          case 'div':
            if (b === 0) throw new VmError('division by zero');
            result = Math.trunc(a / b);
            break;
          case 'mod':
            if (b === 0) throw new VmError('modulo by zero');
            result = a % b;
            break;
        }
        this.stack.length -= 2;
        this.stack.push(result);
        this.pc += 1;
        break;
      }
      case 'load':
        this.stack.push(this.heap.get(instr.addr) ?? 0);
        this.pc += 1;
        break;
      case 'store':
        this.requireStack(1, instr.op);
        this.heap.set(instr.addr, this.stack.pop() as number);
        this.pc += 1;
        break;
      case 'jmp':
        this.checkTarget(instr.target);
        this.pc = instr.target;
        break;
      case 'jz': {
        this.requireStack(1, instr.op);
        const value = this.stack[this.stack.length - 1];
        if (value === 0) {
          this.checkTarget(instr.target);
          this.stack.pop();
          this.pc = instr.target;
        } else {
          this.stack.pop();
          this.pc += 1;
        }
        break;
      }
      case 'call':
        this.checkTarget(instr.target);
        this.callStack.push(this.pc + 1);
        this.pc = instr.target;
        break;
      case 'ret':
        if (this.callStack.length === 0) {
          throw new VmError('call stack underflow on ret');
        }
        this.pc = this.callStack.pop() as number;
        break;
      case 'emit':
        this.requireStack(1, instr.op);
        this.out.push(this.stack.pop() as number);
        this.pc += 1;
        break;
      case 'yield':
        this.yieldedFlag = true;
        this.pc += 1;
        break;
      case 'halt':
        this.haltedFlag = true;
        break;
    }
  }

  private requireStack(needed: number, op: string): void {
    if (this.stack.length < needed) {
      throw new VmError(
        `stack underflow: '${op}' needs ${needed} value(s), have ${this.stack.length}`,
      );
    }
  }

  private checkTarget(target: number): void {
    if (!Number.isInteger(target) || target < 0 || target >= this.program.length) {
      throw new VmError(`illegal jump target: ${target}`);
    }
  }
}
