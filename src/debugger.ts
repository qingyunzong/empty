import { Instruction, VM, VMState, stateEquals } from "./vm.js";

export interface ExecEvent {
  kind: "exec";
  seq: number;
  pc: number;
  op: string;
}

export interface InputEvent {
  kind: "input";
  seq: number;
  value: number;
}

export type TraceEvent = ExecEvent | InputEvent;

export interface Version {
  id: number;
  parentId: number | null;
  forkSeq: number;
  events: TraceEvent[];
  snapshots: Map<number, VMState>;
}

export type StopReason = "halt" | "breakpoint" | "needsInput" | "maxEvents";

export interface RunOptions {
  breakpoints?: Iterable<number>;
  maxEvents?: number;
}

export interface StateMismatch {
  seq: number;
  expected: VMState;
  actual: VMState;
}

export interface VerifyResult {
  ok: boolean;
  eventsReplayed: number;
  snapshotsChecked: number;
  mismatches: StateMismatch[];
  problems: string[];
}

export interface DebuggerOptions {
  numRegs?: number;
  snapshotInterval?: number;
}

export class Debugger {
  private readonly vm: VM;
  private readonly versions = new Map<number, Version>();
  private currentId = 0;
  private nextVersionId = 1;
  private nextSeq = 1;
  private pendingInputs: number[] = [];
  private stoppedAtBreakpoint = false;
  private inSeek = false;
  private readonly snapshotInterval: number;

  constructor(
    private readonly program: Instruction[],
    options: DebuggerOptions = {},
  ) {
    this.vm = new VM(program, options.numRegs ?? 8);
    this.snapshotInterval = Math.max(1, options.snapshotInterval ?? 16);
    const root: Version = {
      id: 0,
      parentId: null,
      forkSeq: 0,
      events: [],
      snapshots: new Map([[0, this.vm.snapshot()]]),
    };
    this.versions.set(root.id, root);
  }

  get state(): VMState {
    return this.vm.snapshot();
  }

  get seq(): number {
    return this.nextSeq - 1;
  }

  get currentVersionId(): number {
    return this.currentId;
  }

  getVersionIds(): number[] {
    return [...this.versions.keys()];
  }

  getVersion(id: number): Version | undefined {
    return this.versions.get(id);
  }

  get events(): TraceEvent[] {
    return this.eventsOf(this.currentId);
  }

  tipOf(versionId = this.currentId): number {
    let v: Version | undefined = this.mustVersion(versionId);
    while (v) {
      if (v.events.length > 0) return v.forkSeq + v.events.length;
      v = v.parentId !== null ? this.versions.get(v.parentId) : undefined;
    }
    return 0;
  }

  provideInput(value: number): void {
    this.pendingInputs.push(value);
  }

  step(): "ok" | "halt" | "needsInput" {
    this.stoppedAtBreakpoint = false;
    return this.executeOne();
  }

  run(options: RunOptions = {}): StopReason {
    const breakpoints = new Set(options.breakpoints ?? []);
    const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
    let skipBreakpointOnce = this.stoppedAtBreakpoint;
    this.stoppedAtBreakpoint = false;
    let executed = 0;
    for (;;) {
      if (this.vm.halted) return "halt";
      if (breakpoints.has(this.vm.pc)) {
        if (skipBreakpointOnce) {
          skipBreakpointOnce = false;
        } else {
          this.stoppedAtBreakpoint = true;
          return "breakpoint";
        }
      }
      const result = this.executeOne();
      if (result === "needsInput") return "needsInput";
      executed += 1;
      if (this.vm.halted) return "halt";
      if (executed >= maxEvents) return "maxEvents";
    }
  }

  seekTo(seq: number): void {
    const tip = this.tipOf();
    if (!Number.isInteger(seq) || seq < 0 || seq > tip) {
      throw new Error(`cannot seek to seq ${seq}; valid range is 0..${tip}`);
    }
    this.stoppedAtBreakpoint = false;
    const snap = this.findSnapshot(seq);
    this.vm.restore(snap.state);
    this.nextSeq = snap.seq + 1;
    this.inSeek = true;
    try {
      while (this.nextSeq <= seq) {
        const result = this.executeOne();
        if (result === "needsInput") throw new Error("internal: replay stalled on missing input");
      }
    } finally {
      this.inSeek = false;
    }
  }

  checkout(versionId: number): void {
    this.mustVersion(versionId);
    this.currentId = versionId;
    this.seekTo(this.tipOf());
  }

  verify(versionId = this.currentId): VerifyResult {
    const events = this.eventsOf(versionId);
    const snapshots = new Map<number, VMState>();
    for (const v of this.chainOf(versionId)) {
      for (const [seq, state] of v.snapshots) snapshots.set(seq, state);
    }
    const vm = new VM(this.program, this.vm.numRegs);
    const mismatches: StateMismatch[] = [];
    const problems: string[] = [];
    let snapshotsChecked = 0;
    let eventsReplayed = 0;
    const checkAt = (seq: number): void => {
      const expected = snapshots.get(seq);
      if (!expected) return;
      snapshotsChecked += 1;
      const actual = vm.snapshot();
      if (!stateEquals(expected, actual)) mismatches.push({ seq, expected, actual });
    };
    checkAt(0);
    let pendingInput: number | undefined;
    for (const ev of events) {
      if (ev.kind === "input") {
        pendingInput = ev.value;
        continue;
      }
      const instr = this.program[vm.pc];
      if (!instr || instr.op !== ev.op || vm.pc !== ev.pc) {
        problems.push(`divergence at seq ${ev.seq}: trace says ${ev.op}@pc=${ev.pc}, replay has ${instr?.op ?? "<eof>"}@pc=${vm.pc}`);
        break;
      }
      if (instr.op === "in") {
        if (pendingInput === undefined) {
          problems.push(`missing recorded input for in@pc=${vm.pc} (seq ${ev.seq})`);
          break;
        }
        vm.step(pendingInput);
        pendingInput = undefined;
      } else {
        vm.step();
      }
      eventsReplayed += 1;
      checkAt(ev.seq);
    }
    return {
      ok: mismatches.length === 0 && problems.length === 0,
      eventsReplayed,
      snapshotsChecked,
      mismatches,
      problems,
    };
  }

  private executeOne(): "ok" | "halt" | "needsInput" {
    if (this.vm.halted) return "halt";
    const pc = this.vm.pc;
    const instr = this.program[pc];
    if (!instr) throw new Error(`no instruction at pc=${pc}`);
    let inputValue: number | undefined;
    if (instr.op === "in") {
      const recorded = this.peekEvent();
      if (recorded && recorded.kind !== "input") {
        throw new Error(`trace divergence at seq ${this.nextSeq}: expected input event, found exec`);
      }
      const recordedValue = recorded?.kind === "input" ? recorded.value : undefined;
      const pending = this.inSeek || this.pendingInputs.length === 0 ? undefined : this.pendingInputs[0]!;
      if (pending !== undefined && pending !== recordedValue) {
        inputValue = this.pendingInputs.shift()!;
        this.forkIfDiverging();
        this.appendEvent({ kind: "input", seq: this.nextSeq, value: inputValue });
      } else if (recordedValue !== undefined) {
        if (pending !== undefined) this.pendingInputs.shift();
        inputValue = recordedValue;
        this.nextSeq += 1;
      } else if (pending !== undefined) {
        inputValue = this.pendingInputs.shift()!;
        this.appendEvent({ kind: "input", seq: this.nextSeq, value: inputValue });
      } else {
        return "needsInput";
      }
    }
    const recordedExec = this.peekEvent();
    if (recordedExec !== undefined) {
      if (recordedExec.kind !== "exec" || recordedExec.pc !== pc || recordedExec.op !== instr.op) {
        throw new Error(`trace divergence at seq ${this.nextSeq}: replay does not match recorded trace`);
      }
      this.nextSeq += 1;
    } else {
      this.appendEvent({ kind: "exec", seq: this.nextSeq, pc, op: instr.op });
    }
    this.vm.step(inputValue);
    this.maybeSnapshot();
    return this.vm.halted ? "halt" : "ok";
  }

  private forkIfDiverging(): void {
    if (this.seq >= this.tipOf()) return;
    const child: Version = {
      id: this.nextVersionId++,
      parentId: this.currentId,
      forkSeq: this.seq,
      events: [],
      snapshots: new Map(),
    };
    this.versions.set(child.id, child);
    this.currentId = child.id;
  }

  private appendEvent(ev: TraceEvent): void {
    const version = this.currentVersion();
    if (ev.seq !== version.forkSeq + version.events.length + 1) {
      throw new Error(`internal: cannot append event seq ${ev.seq} to version ${version.id}`);
    }
    version.events.push(ev);
    this.nextSeq += 1;
  }

  private maybeSnapshot(): void {
    const seq = this.nextSeq - 1;
    if (seq % this.snapshotInterval === 0) {
      this.currentVersion().snapshots.set(seq, this.vm.snapshot());
    }
  }

  private peekEvent(): TraceEvent | undefined {
    const seq = this.nextSeq;
    let v: Version | undefined = this.currentVersion();
    while (v) {
      if (seq > v.forkSeq) return v.events[seq - v.forkSeq - 1];
      v = v.parentId !== null ? this.versions.get(v.parentId) : undefined;
    }
    return undefined;
  }

  private findSnapshot(seq: number): { seq: number; state: VMState } {
    let v: Version | undefined = this.currentVersion();
    while (v) {
      let best = -1;
      for (const key of v.snapshots.keys()) {
        if (key <= seq && key > best) best = key;
      }
      if (best >= 0) return { seq: best, state: v.snapshots.get(best)! };
      v = v.parentId !== null ? this.versions.get(v.parentId) : undefined;
    }
    throw new Error("internal: no snapshot available");
  }

  private eventsOf(versionId: number): TraceEvent[] {
    const chain = this.chainOf(versionId);
    const out: TraceEvent[] = [];
    let limit = Number.POSITIVE_INFINITY;
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = chain[i]!;
      out.unshift(...v.events.filter((e) => e.seq <= limit));
      limit = v.forkSeq;
    }
    return out;
  }

  private chainOf(versionId: number): Version[] {
    const chain: Version[] = [];
    let v: Version | undefined = this.mustVersion(versionId);
    while (v) {
      chain.unshift(v);
      v = v.parentId !== null ? this.versions.get(v.parentId) : undefined;
    }
    return chain;
  }

  private currentVersion(): Version {
    return this.versions.get(this.currentId)!;
  }

  private mustVersion(id: number): Version {
    const v = this.versions.get(id);
    if (!v) throw new Error(`unknown version ${id}`);
    return v;
  }
}
