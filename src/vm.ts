export type Instruction =
  | { op: "const"; dst: number; value: number }
  | { op: "mov"; dst: number; src: number }
  | { op: "add"; dst: number; a: number; b: number }
  | { op: "sub"; dst: number; a: number; b: number }
  | { op: "mul"; dst: number; a: number; b: number }
  | { op: "load"; dst: number; addr: number }
  | { op: "store"; addr: number; src: number }
  | { op: "jmp"; target: number }
  | { op: "jz"; cond: number; target: number }
  | { op: "in"; dst: number }
  | { op: "out"; src: number }
  | { op: "halt" };

export interface VMState {
  pc: number;
  regs: number[];
  heap: Map<number, number>;
  outputs: number[];
  halted: boolean;
}

export class VM {
  pc = 0;
  regs: number[];
  heap = new Map<number, number>();
  outputs: number[] = [];
  halted = false;

  constructor(
    public readonly program: Instruction[],
    numRegs = 8,
  ) {
    this.regs = new Array<number>(numRegs).fill(0);
  }

  get numRegs(): number {
    return this.regs.length;
  }

  snapshot(): VMState {
    return {
      pc: this.pc,
      regs: [...this.regs],
      heap: new Map(this.heap),
      outputs: [...this.outputs],
      halted: this.halted,
    };
  }

  restore(state: VMState): void {
    this.pc = state.pc;
    this.regs = [...state.regs];
    this.heap = new Map(state.heap);
    this.outputs = [...state.outputs];
    this.halted = state.halted;
  }

  step(input?: number): void {
    if (this.halted) return;
    const instr = this.program[this.pc];
    if (!instr) throw new Error(`no instruction at pc=${this.pc}`);
    switch (instr.op) {
      case "const":
        this.regs[instr.dst] = instr.value;
        this.pc += 1;
        break;
      case "mov":
        this.regs[instr.dst] = this.regs[instr.src]!;
        this.pc += 1;
        break;
      case "add":
        this.regs[instr.dst] = this.regs[instr.a]! + this.regs[instr.b]!;
        this.pc += 1;
        break;
      case "sub":
        this.regs[instr.dst] = this.regs[instr.a]! - this.regs[instr.b]!;
        this.pc += 1;
        break;
      case "mul":
        this.regs[instr.dst] = this.regs[instr.a]! * this.regs[instr.b]!;
        this.pc += 1;
        break;
      case "load":
        this.regs[instr.dst] = this.heap.get(instr.addr) ?? 0;
        this.pc += 1;
        break;
      case "store":
        this.heap.set(instr.addr, this.regs[instr.src]!);
        this.pc += 1;
        break;
      case "jmp":
        this.pc = instr.target;
        break;
      case "jz":
        this.pc = this.regs[instr.cond] === 0 ? instr.target : this.pc + 1;
        break;
      case "in":
        if (input === undefined) throw new Error("external input required");
        this.regs[instr.dst] = input;
        this.pc += 1;
        break;
      case "out":
        this.outputs.push(this.regs[instr.src]!);
        this.pc += 1;
        break;
      case "halt":
        this.halted = true;
        break;
    }
  }
}

export function stateEquals(a: VMState, b: VMState): boolean {
  if (a.pc !== b.pc || a.halted !== b.halted) return false;
  if (a.regs.length !== b.regs.length) return false;
  for (let i = 0; i < a.regs.length; i++) if (a.regs[i] !== b.regs[i]) return false;
  if (a.outputs.length !== b.outputs.length) return false;
  for (let i = 0; i < a.outputs.length; i++) if (a.outputs[i] !== b.outputs[i]) return false;
  if (a.heap.size !== b.heap.size) return false;
  for (const [addr, value] of a.heap) if (b.heap.get(addr) !== value) return false;
  return true;
}
