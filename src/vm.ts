/**
 * 整数栈虚拟机：支持算术、跳转、调用、堆读写与 yield。
 * 快照包含指令位置（pc）、操作数栈、调用栈与堆；
 * 非法跳转与栈下溢等错误在执行前校验，失败时不改变任何状态。
 */

export type Instruction =
  | { op: "push"; value: number }
  | { op: "pop" }
  | { op: "dup" }
  | { op: "add" }
  | { op: "sub" }
  | { op: "mul" }
  | { op: "div" }
  | { op: "mod" }
  | { op: "neg" }
  | { op: "jmp"; target: number }
  | { op: "jz"; target: number }
  | { op: "jnz"; target: number }
  | { op: "call"; target: number; arity: number }
  | { op: "ret" }
  | { op: "load"; addr: number }
  | { op: "store"; addr: number }
  | { op: "out" }
  | { op: "yield" }
  | { op: "halt" };

export interface CallFrame {
  /** 调用返回后应跳转到的指令位置 */
  returnPc: number;
  /** 调用时操作数栈深度减去实参个数，ret 时栈被恢复到此深度后压入返回值 */
  base: number;
}

export interface Snapshot {
  pc: number;
  stack: number[];
  callStack: CallFrame[];
  heap: number[];
  output: number[];
  halted: boolean;
}

export type VmErrorCode =
  | "STACK_UNDERFLOW"
  | "ILLEGAL_JUMP"
  | "DIVIDE_BY_ZERO"
  | "HEAP_OUT_OF_BOUNDS"
  | "CALL_STACK_UNDERFLOW"
  | "INVALID_SNAPSHOT"
  | "HALTED";

export class VmError extends Error {
  constructor(
    public readonly code: VmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VmError";
  }
}

export type StepResult = "ok" | "yielded" | "halted";
export type RunResult = "yielded" | "halted";

export class VM {
  private pc = 0;
  private stack: number[] = [];
  private callStack: CallFrame[] = [];
  private heap: number[];
  private output: number[] = [];
  private halted = false;

  constructor(
    private readonly program: readonly Instruction[],
    heapSize = 256,
  ) {
    if (!Number.isInteger(heapSize) || heapSize < 0) {
      throw new VmError("INVALID_SNAPSHOT", `invalid heap size: ${heapSize}`);
    }
    this.heap = new Array<number>(heapSize).fill(0);
  }

  get isHalted(): boolean {
    return this.halted;
  }

  getOutput(): readonly number[] {
    return this.output;
  }

  /** 深拷贝当前完整状态：pc、操作数栈、调用栈、堆、输出与停机标志。 */
  snapshot(): Snapshot {
    return {
      pc: this.pc,
      stack: [...this.stack],
      callStack: this.callStack.map((f) => ({ ...f })),
      heap: [...this.heap],
      output: [...this.output],
      halted: this.halted,
    };
  }

  /** 校验并恢复快照；非法快照抛错且不改变当前状态。 */
  restore(snapshot: Snapshot): void {
    this.validateSnapshot(snapshot);
    this.pc = snapshot.pc;
    this.stack = [...snapshot.stack];
    this.callStack = snapshot.callStack.map((f) => ({ ...f }));
    this.heap = [...snapshot.heap];
    this.output = [...snapshot.output];
    this.halted = snapshot.halted;
  }

  /** 执行直到 halt 或 yield。 */
  run(): RunResult {
    for (;;) {
      if (this.halted) return "halted";
      const r = this.step();
      if (r === "yielded") return "yielded";
    }
  }

  /**
   * 执行单条指令。所有校验先于任何状态修改，
   * 因此非法跳转、栈下溢、除零、堆越界等错误均不改变状态。
   */
  step(): StepResult {
    if (this.halted) {
      throw new VmError("HALTED", "cannot step a halted VM");
    }
    const ins = this.program[this.pc];
    if (ins === undefined) {
      throw new VmError("ILLEGAL_JUMP", `pc out of bounds: ${this.pc}`);
    }

    switch (ins.op) {
      case "push":
        this.stack.push(ins.value);
        this.pc += 1;
        return "ok";

      case "pop":
        this.requireStack(1, ins.op);
        this.stack.pop();
        this.pc += 1;
        return "ok";

      case "dup":
        this.requireStack(1, ins.op);
        this.stack.push(this.stack[this.stack.length - 1]!);
        this.pc += 1;
        return "ok";

      case "add":
      case "sub":
      case "mul":
      case "div":
      case "mod": {
        this.requireStack(2, ins.op);
        const b = this.stack[this.stack.length - 1]!;
        const a = this.stack[this.stack.length - 2]!;
        if ((ins.op === "div" || ins.op === "mod") && b === 0) {
          throw new VmError("DIVIDE_BY_ZERO", `${ins.op} by zero`);
        }
        let r: number;
        switch (ins.op) {
          case "add": r = a + b; break;
          case "sub": r = a - b; break;
          case "mul": r = a * b; break;
          case "div": r = Math.trunc(a / b); break;
          default:    r = a % b; break;
        }
        this.stack.length -= 2;
        this.stack.push(r);
        this.pc += 1;
        return "ok";
      }

      case "neg":
        this.requireStack(1, ins.op);
        this.stack[this.stack.length - 1] = -this.stack[this.stack.length - 1]!;
        this.pc += 1;
        return "ok";

      case "jmp":
        this.requireTarget(ins.target);
        this.pc = ins.target;
        return "ok";

      case "jz":
      case "jnz": {
        this.requireStack(1, ins.op);
        this.requireTarget(ins.target);
        const v = this.stack.pop()!;
        const taken = ins.op === "jz" ? v === 0 : v !== 0;
        this.pc = taken ? ins.target : this.pc + 1;
        return "ok";
      }

      case "call": {
        this.requireTarget(ins.target);
        if (!Number.isInteger(ins.arity) || ins.arity < 0 || ins.arity > this.stack.length) {
          throw new VmError(
            "STACK_UNDERFLOW",
            `call arity ${ins.arity} exceeds stack depth ${this.stack.length}`,
          );
        }
        this.callStack.push({ returnPc: this.pc + 1, base: this.stack.length - ins.arity });
        this.pc = ins.target;
        return "ok";
      }

      case "ret": {
        const frame = this.callStack[this.callStack.length - 1];
        if (frame === undefined) {
          throw new VmError("CALL_STACK_UNDERFLOW", "ret with empty call stack");
        }
        if (this.stack.length <= frame.base) {
          throw new VmError(
            "STACK_UNDERFLOW",
            `ret needs a result above base ${frame.base}, stack depth ${this.stack.length}`,
          );
        }
        const result = this.stack[this.stack.length - 1]!;
        this.callStack.pop();
        this.stack.length = frame.base;
        this.stack.push(result);
        this.pc = frame.returnPc;
        return "ok";
      }

      case "load": {
        this.requireHeap(ins.addr);
        this.stack.push(this.heap[ins.addr]!);
        this.pc += 1;
        return "ok";
      }

      case "store": {
        this.requireStack(1, ins.op);
        this.requireHeap(ins.addr);
        this.heap[ins.addr] = this.stack.pop()!;
        this.pc += 1;
        return "ok";
      }

      case "out":
        this.requireStack(1, ins.op);
        this.output.push(this.stack.pop()!);
        this.pc += 1;
        return "ok";

      case "yield":
        this.pc += 1;
        return "yielded";

      case "halt":
        this.halted = true;
        return "halted";
    }
  }

  private requireStack(n: number, op: string): void {
    if (this.stack.length < n) {
      throw new VmError(
        "STACK_UNDERFLOW",
        `${op} needs ${n} operand(s), stack depth ${this.stack.length}`,
      );
    }
  }

  private requireTarget(target: number): void {
    if (!Number.isInteger(target) || target < 0 || target >= this.program.length) {
      throw new VmError("ILLEGAL_JUMP", `jump target ${target} is not an instruction boundary`);
    }
  }

  private requireHeap(addr: number): void {
    if (!Number.isInteger(addr) || addr < 0 || addr >= this.heap.length) {
      throw new VmError("HEAP_OUT_OF_BOUNDS", `heap address ${addr} out of bounds`);
    }
  }

  private validateSnapshot(s: Snapshot): void {
    const bad = (msg: string) => new VmError("INVALID_SNAPSHOT", msg);
    if (!Number.isInteger(s.pc) || s.pc < 0 || s.pc > this.program.length) {
      throw bad(`pc ${s.pc} is not an instruction boundary`);
    }
    if (!Array.isArray(s.stack) || !Array.isArray(s.callStack) || !Array.isArray(s.output)) {
      throw bad("stack/callStack/output must be arrays");
    }
    if (!Array.isArray(s.heap) || s.heap.length !== this.heap.length) {
      throw bad(`heap size ${s.heap?.length} does not match VM heap size ${this.heap.length}`);
    }
    for (const frame of s.callStack) {
      if (!Number.isInteger(frame.returnPc) || frame.returnPc < 0 || frame.returnPc > this.program.length) {
        throw bad(`frame returnPc ${frame.returnPc} is not an instruction boundary`);
      }
      if (!Number.isInteger(frame.base) || frame.base < 0 || frame.base > s.stack.length) {
        throw bad(`frame base ${frame.base} out of range`);
      }
    }
  }
}
