import {
  VM,
  NeedInputError,
  cloneState,
  disassemble,
  hashState,
  type Instruction,
  type VmOptions,
  type VmState,
} from './vm.js';

/** One recorded execution event. Only executed instructions produce events;
 *  breakpoint hits never do. */
export interface ExecEvent {
  seq: number;
  pc: number;
  op: string;
  inputUsed: number | null;
  state: VmState;   // full post-state snapshot
  hash: string;     // digest of `state`
}

/** A line of history. A fork shares its parent's prefix and diverges after
 *  `forkSeq`. */
export interface Version {
  id: number;
  parentId: number | null;
  forkSeq: number | null;
  events: ExecEvent[];
  inputs: number[];        // external inputs in consumption order
  halted: boolean;
  finalHash: string | null;
}

export interface VersionInfo {
  id: number;
  parentId: number | null;
  forkSeq: number | null;
  eventCount: number;
  inputs: number[];
  halted: boolean;
  finalHash: string | null;
}

export type StopReason = 'halted' | 'breakpoint' | 'need-input';

export interface ContinueResult {
  stop: StopReason;
  recorded: number;   // steps appended as new events
  verified: number;   // steps replayed and verified against the log
  breakpointPc?: number;
}

export type StepResult =
  | { kind: 'recorded'; event: ExecEvent }
  | { kind: 'verified'; event: ExecEvent }
  | { kind: 'forked'; versionId: number; event: ExecEvent }
  | { kind: 'need-input' }
  | { kind: 'halted' };

export interface VerifyReport {
  ok: boolean;
  eventsChecked: number;
  mismatch: { seq: number; expectedHash: string; actualHash: string } | null;
}

export class DivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DivergenceError';
  }
}

export class DebugSession {
  private vm: VM;
  private readonly initialState: VmState;
  private readonly versions = new Map<number, Version>();
  private currentId = 0;
  private nextVersionId = 1;
  /** Index of the next event to verify against; equals events.length when recording. */
  private replayCursor = 0;
  /** User-supplied inputs not yet consumed. */
  private pendingInputs: number[] = [];
  private readonly breakpoints = new Set<number>();
  private resumeGuard: number | null = null;
  /** Breakpoint hits are tracked separately and are NOT execution events. */
  readonly breakpointHits: { pc: number; nextSeq: number }[] = [];

  constructor(program: Instruction[], options: VmOptions = {}) {
    this.vm = new VM(program, options);
    this.initialState = this.vm.snapshot();
    this.versions.set(0, {
      id: 0,
      parentId: null,
      forkSeq: null,
      events: [],
      inputs: [],
      halted: false,
      finalHash: null,
    });
  }

  get currentVersion(): Version {
    return this.versions.get(this.currentId)!;
  }

  get currentVersionId(): number {
    return this.currentId;
  }

  get versionCount(): number {
    return this.versions.size;
  }

  get events(): readonly ExecEvent[] {
    return this.currentVersion.events;
  }

  get inputs(): readonly number[] {
    return this.currentVersion.inputs;
  }

  /** Seq the next executed instruction will verify against or be recorded as. */
  get nextSeq(): number {
    return this.replayCursor;
  }

  get halted(): boolean {
    return this.vm.halted;
  }

  /** Live machine state (deep copy). */
  get state(): VmState {
    return this.vm.snapshot();
  }

  listVersions(): VersionInfo[] {
    return [...this.versions.values()].map((v) => ({
      id: v.id,
      parentId: v.parentId,
      forkSeq: v.forkSeq,
      eventCount: v.events.length,
      inputs: v.inputs.slice(),
      halted: v.halted,
      finalHash: v.finalHash,
    }));
  }

  /** Full state snapshot stored at an event; -1 is the initial state. */
  snapshotAt(seq: number): VmState {
    if (seq === -1) return cloneState(this.initialState);
    const event = this.currentVersion.events[seq];
    if (!event) throw new RangeError(`no event at seq ${seq}`);
    return cloneState(event.state);
  }

  /** Time travel: restore registers/heap (and the rest of the machine state)
   *  to just after event `seq`. Use -1 for the initial state. */
  jumpTo(seq: number): VmState {
    const state = this.snapshotAt(seq);
    this.vm.restore(state);
    this.replayCursor = seq + 1;
    this.resumeGuard = null;
    return cloneState(state);
  }

  /** Switch to another recorded version, positioned after its last event. */
  switchVersion(id: number): void {
    const version = this.versions.get(id);
    if (!version) throw new RangeError(`unknown version ${id}`);
    this.currentId = id;
    this.jumpTo(version.events.length - 1);
  }

  setBreakpoint(pc: number): void {
    this.breakpoints.add(pc);
  }

  clearBreakpoint(pc: number): void {
    this.breakpoints.delete(pc);
  }

  getBreakpoints(): number[] {
    return [...this.breakpoints].sort((a, b) => a - b);
  }

  /** Queue an external input. If it diverges from the recorded input at the
   *  replay position, the next step automatically forks a new version. */
  supplyInput(value: number): void {
    this.pendingInputs.push(value);
  }

  /** Explicitly fork a new version positioned after event `seq`. */
  forkAt(seq: number): number {
    this.jumpTo(seq);
    return this.forkHere().id;
  }

  private forkHere(): Version {
    const parent = this.currentVersion;
    const child: Version = {
      id: this.nextVersionId++,
      parentId: parent.id,
      forkSeq: this.replayCursor - 1,
      events: parent.events.slice(0, this.replayCursor),
      inputs: parent.inputs.slice(0, this.vm.snapshot().inputsConsumed),
      halted: false,
      finalHash: null,
    };
    this.versions.set(child.id, child);
    this.currentId = child.id;
    return child;
  }

  /** Execute exactly one instruction: verify against the log when replaying,
   *  append a new event when past the recorded end, fork on input divergence. */
  step(): StepResult {
    if (this.vm.halted) return { kind: 'halted' };

    let recorded = this.replayCursor < this.currentVersion.events.length
      ? this.currentVersion.events[this.replayCursor]
      : null;
    const nextIns = this.vm.peek();
    let forked: Version | null = null;

    if (nextIns && nextIns.op === 'IN') {
      const userValue = this.pendingInputs.length > 0 ? this.pendingInputs[0] : null;
      if (userValue !== null) {
        if (recorded && recorded.inputUsed !== null && recorded.inputUsed !== userValue) {
          // New input diverges from the recording: fork before consuming it.
          forked = this.forkHere();
          recorded = null;
        }
        this.pendingInputs.shift();
        this.vm.queueInput(userValue);
      } else if (recorded && recorded.inputUsed !== null) {
        // Replay with the recorded input.
        this.vm.queueInput(recorded.inputUsed);
      } else {
        return { kind: 'need-input' };
      }
    }

    let info;
    try {
      info = this.vm.step();
    } catch (err) {
      if (err instanceof NeedInputError) return { kind: 'need-input' };
      throw err;
    }
    this.resumeGuard = null;

    const state = this.vm.snapshot();
    const hash = hashState(state);
    const op = disassemble(info.instruction);
    const version = this.currentVersion;

    if (!forked && this.replayCursor < version.events.length) {
      const expected = version.events[this.replayCursor];
      if (
        expected.pc !== info.pc ||
        expected.op !== op ||
        expected.inputUsed !== info.inputUsed ||
        expected.hash !== hash
      ) {
        throw new DivergenceError(
          `execution diverged at seq ${expected.seq}: expected ${expected.op} (hash ${expected.hash}), got ${op} (hash ${hash})`,
        );
      }
      this.replayCursor += 1;
      return { kind: 'verified', event: expected };
    }

    const event: ExecEvent = {
      seq: version.events.length,
      pc: info.pc,
      op,
      inputUsed: info.inputUsed,
      state,
      hash,
    };
    version.events.push(event);
    if (info.inputUsed !== null) version.inputs.push(info.inputUsed);
    if (this.vm.halted) {
      version.halted = true;
      version.finalHash = hash;
    }
    this.replayCursor += 1;
    return forked
      ? { kind: 'forked', versionId: forked.id, event }
      : { kind: 'recorded', event };
  }

  /** Run until halt, breakpoint, or missing input. Queues `inputs` first. */
  continue(inputs: number[] = []): ContinueResult {
    for (const value of inputs) this.supplyInput(value);
    let recordedCount = 0;
    let verifiedCount = 0;

    for (;;) {
      if (this.vm.halted) {
        return { stop: 'halted', recorded: recordedCount, verified: verifiedCount };
      }
      const pc = this.vm.snapshot().pc;
      if (this.breakpoints.has(pc) && this.resumeGuard !== pc) {
        this.resumeGuard = pc;
        this.breakpointHits.push({ pc, nextSeq: this.replayCursor });
        return { stop: 'breakpoint', recorded: recordedCount, verified: verifiedCount, breakpointPc: pc };
      }
      const result = this.step();
      if (result.kind === 'need-input') {
        return { stop: 'need-input', recorded: recordedCount, verified: verifiedCount };
      }
      if (result.kind === 'halted') {
        return { stop: 'halted', recorded: recordedCount, verified: verifiedCount };
      }
      if (result.kind === 'verified') verifiedCount += 1;
      else recordedCount += 1;
    }
  }

  /** Replay a whole version from the initial state, checking the full state
   *  snapshot hash after every single event. */
  verify(versionId: number = this.currentId): VerifyReport {
    const version = this.versions.get(versionId);
    if (!version) throw new RangeError(`unknown version ${versionId}`);

    const vm = new VM(this.vm.program, {
      registerCount: this.vm.registerCount,
      heapSize: this.vm.heapSize,
    });
    vm.restore(cloneState(this.initialState));

    for (const event of version.events) {
      // Snapshot self-integrity: stored state must match its stored hash.
      if (hashState(event.state) !== event.hash) {
        return {
          ok: false,
          eventsChecked: event.seq,
          mismatch: { seq: event.seq, expectedHash: event.hash, actualHash: hashState(event.state) },
        };
      }
      const ins = vm.peek();
      if (ins && ins.op === 'IN') {
        if (event.inputUsed === null) {
          return {
            ok: false,
            eventsChecked: event.seq,
            mismatch: { seq: event.seq, expectedHash: event.hash, actualHash: 'missing recorded input' },
          };
        }
        vm.queueInput(event.inputUsed);
      }
      const info = vm.step();
      const actualHash = hashState(vm.snapshot());
      if (
        info.pc !== event.pc ||
        disassemble(info.instruction) !== event.op ||
        info.inputUsed !== event.inputUsed ||
        actualHash !== event.hash
      ) {
        return {
          ok: false,
          eventsChecked: event.seq,
          mismatch: { seq: event.seq, expectedHash: event.hash, actualHash },
        };
      }
    }
    return { ok: true, eventsChecked: version.events.length, mismatch: null };
  }
}
