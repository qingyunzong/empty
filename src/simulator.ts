export type Instruction =
  | { op: "set"; dst: string; value: number }
  | { op: "add"; dst: string; value: number }
  | { op: "read"; var: string; dst: string }
  | { op: "write"; var: string; src: number | string }
  | { op: "lock"; mutex: string }
  | { op: "unlock"; mutex: string }
  | { op: "jnz"; reg: string; target: number };

export interface ProgramDef {
  shared: Record<string, number>;
  threads: Instruction[][];
}

export const MAX_THREADS = 3;

export type ThreadStatus = "ready" | "blocked" | "done";

export interface ThreadSnapshot {
  pc: number;
  status: ThreadStatus;
  locals: Record<string, number>;
}

export interface Snapshot {
  steps: number;
  shared: Record<string, number>;
  locks: Record<string, number | null>;
  threads: ThreadSnapshot[];
  allDone: boolean;
  deadlocked: boolean;
}

export type RunOutcome = "done" | "deadlock" | "incomplete";

export interface RunResult {
  outcome: RunOutcome;
  trace: Snapshot[];
  final: Snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProgram(raw: unknown): ProgramDef {
  if (!isRecord(raw)) throw new Error("program must be a JSON object");
  const sharedRaw = raw.shared ?? {};
  if (!isRecord(sharedRaw)) throw new Error('"shared" must be an object of name -> number');
  const shared: Record<string, number> = {};
  for (const [name, value] of Object.entries(sharedRaw)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`shared["${name}"] must be a finite number`);
    }
    shared[name] = value;
  }
  const threadsRaw = raw.threads;
  if (!Array.isArray(threadsRaw) || threadsRaw.length < 1 || threadsRaw.length > MAX_THREADS) {
    throw new Error(`"threads" must be an array of 1..${MAX_THREADS} threads`);
  }
  const threads = threadsRaw.map((thread, ti) => validateThread(thread, ti, shared));
  return { shared, threads };
}

function validateThread(raw: unknown, ti: number, shared: Record<string, number>): Instruction[] {
  if (!Array.isArray(raw)) throw new Error(`thread ${ti} must be an array of instructions`);
  return raw.map((item, pc) => validateInstruction(item, ti, pc, raw.length, shared));
}

function validateInstruction(
  raw: unknown,
  ti: number,
  pc: number,
  threadLen: number,
  shared: Record<string, number>
): Instruction {
  const where = `thread ${ti} instruction ${pc}`;
  if (!isRecord(raw) || typeof raw.op !== "string") throw new Error(`${where}: missing "op"`);
  const needString = (name: string): string => {
    const value = raw[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${where}: "${name}" must be a non-empty string`);
    }
    return value;
  };
  const needNumber = (name: string): number => {
    const value = raw[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${where}: "${name}" must be a finite number`);
    }
    return value;
  };
  const needSharedVar = (name: string): string => {
    const value = needString(name);
    if (!(value in shared)) throw new Error(`${where}: shared variable "${value}" is not declared`);
    return value;
  };
  switch (raw.op) {
    case "set":
      return { op: "set", dst: needString("dst"), value: needNumber("value") };
    case "add":
      return { op: "add", dst: needString("dst"), value: needNumber("value") };
    case "read":
      return { op: "read", var: needSharedVar("var"), dst: needString("dst") };
    case "write": {
      const sharedVar = needSharedVar("var");
      const src = raw.src;
      if (typeof src !== "number" && typeof src !== "string") {
        throw new Error(`${where}: "src" must be a number or a register name`);
      }
      return { op: "write", var: sharedVar, src };
    }
    case "lock":
      return { op: "lock", mutex: needString("mutex") };
    case "unlock":
      return { op: "unlock", mutex: needString("mutex") };
    case "jnz": {
      const reg = needString("reg");
      const target = raw.target;
      if (!Number.isInteger(target) || (target as number) < 0 || (target as number) >= threadLen) {
        throw new Error(`${where}: "target" must be an integer in [0, ${threadLen - 1}]`);
      }
      return { op: "jnz", reg, target: target as number };
    }
    default:
      throw new Error(`${where}: unknown op "${raw.op}"`);
  }
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

export class Simulator {
  readonly program: ProgramDef;
  private shared: Record<string, number>;
  private locks = new Map<string, number | null>();
  private pcs: number[];
  private locals: Record<string, number>[];
  steps = 0;

  constructor(program: ProgramDef) {
    this.program = program;
    this.shared = { ...program.shared };
    for (const thread of program.threads) {
      for (const ins of thread) {
        if ((ins.op === "lock" || ins.op === "unlock") && !this.locks.has(ins.mutex)) {
          this.locks.set(ins.mutex, null);
        }
      }
    }
    this.pcs = program.threads.map(() => 0);
    this.locals = program.threads.map(() => ({}));
  }

  get threadCount(): number {
    return this.program.threads.length;
  }

  clone(): Simulator {
    const copy = new Simulator(this.program);
    copy.shared = { ...this.shared };
    copy.locks = new Map(this.locks);
    copy.pcs = [...this.pcs];
    copy.locals = this.locals.map((regs) => ({ ...regs }));
    copy.steps = this.steps;
    return copy;
  }

  isDone(tid: number): boolean {
    return this.pcs[tid] >= this.program.threads[tid].length;
  }

  allDone(): boolean {
    return this.program.threads.every((_, tid) => this.isDone(tid));
  }

  status(tid: number): ThreadStatus {
    if (this.isDone(tid)) return "done";
    return this.isRunnable(tid) ? "ready" : "blocked";
  }

  isRunnable(tid: number): boolean {
    if (this.isDone(tid)) return false;
    const ins = this.program.threads[tid][this.pcs[tid]];
    if (ins.op === "lock") {
      const holder = this.locks.get(ins.mutex) ?? null;
      return holder === null || holder === tid;
    }
    return true;
  }

  runnableThreads(): number[] {
    const out: number[] = [];
    for (let tid = 0; tid < this.threadCount; tid++) {
      if (this.isRunnable(tid)) out.push(tid);
    }
    return out;
  }

  isDeadlocked(): boolean {
    return !this.allDone() && this.runnableThreads().length === 0;
  }

  step(tid: number): void {
    if (!Number.isInteger(tid) || tid < 0 || tid >= this.threadCount) {
      throw new Error(`invalid thread id ${tid}`);
    }
    if (this.isDone(tid)) throw new Error(`thread ${tid} has already finished`);
    const ins = this.program.threads[tid][this.pcs[tid]];
    const regs = this.locals[tid];
    switch (ins.op) {
      case "set":
        regs[ins.dst] = ins.value;
        this.pcs[tid]++;
        break;
      case "add":
        regs[ins.dst] = (regs[ins.dst] ?? 0) + ins.value;
        this.pcs[tid]++;
        break;
      case "read":
        regs[ins.dst] = this.shared[ins.var];
        this.pcs[tid]++;
        break;
      case "write":
        this.shared[ins.var] = typeof ins.src === "number" ? ins.src : (regs[ins.src] ?? 0);
        this.pcs[tid]++;
        break;
      case "jnz":
        this.pcs[tid] = (regs[ins.reg] ?? 0) !== 0 ? ins.target : this.pcs[tid] + 1;
        break;
      case "lock": {
        const holder = this.locks.get(ins.mutex) ?? null;
        if (holder === null) {
          this.locks.set(ins.mutex, tid);
          this.pcs[tid]++;
        } else if (holder === tid) {
          throw new Error(`thread ${tid} re-locks mutex "${ins.mutex}" it already holds`);
        } else {
          throw new Error(`thread ${tid} is blocked on mutex "${ins.mutex}" held by thread ${holder}`);
        }
        break;
      }
      case "unlock": {
        const holder = this.locks.get(ins.mutex) ?? null;
        if (holder !== tid) {
          const who = holder === null ? "nobody" : `thread ${holder}`;
          throw new Error(`thread ${tid} cannot unlock mutex "${ins.mutex}" held by ${who}`);
        }
        this.locks.set(ins.mutex, null);
        this.pcs[tid]++;
        break;
      }
    }
    this.steps++;
  }

  run(schedule: number[]): RunResult {
    const trace: Snapshot[] = [this.snapshot()];
    for (const tid of schedule) {
      if (this.allDone() || this.isDeadlocked()) break;
      if (!this.isRunnable(tid)) {
        throw new Error(`invalid schedule: thread ${tid} is not runnable at step ${this.steps}`);
      }
      this.step(tid);
      trace.push(this.snapshot());
    }
    const final = this.snapshot();
    const outcome: RunOutcome = final.allDone ? "done" : final.deadlocked ? "deadlock" : "incomplete";
    return { outcome, trace, final };
  }

  snapshot(): Snapshot {
    const locks: Record<string, number | null> = {};
    for (const name of [...this.locks.keys()].sort()) {
      locks[name] = this.locks.get(name) ?? null;
    }
    return {
      steps: this.steps,
      shared: sortedRecord(this.shared),
      locks,
      threads: this.program.threads.map((_, tid) => ({
        pc: this.pcs[tid],
        status: this.status(tid),
        locals: sortedRecord(this.locals[tid]),
      })),
      allDone: this.allDone(),
      deadlocked: this.isDeadlocked(),
    };
  }

  stateKey(): string {
    return JSON.stringify([
      this.pcs,
      this.locals.map(sortedRecord),
      sortedRecord(this.shared),
      [...this.locks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ]);
  }

  resultKey(): string {
    const locks: Record<string, number | null> = {};
    for (const name of [...this.locks.keys()].sort()) {
      locks[name] = this.locks.get(name) ?? null;
    }
    return JSON.stringify([sortedRecord(this.shared), locks]);
  }
}

export function runProgram(program: ProgramDef, schedule: number[]): RunResult {
  return new Simulator(program).run(schedule);
}
