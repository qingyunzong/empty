/**
 * Debug-library event trace model and replayer.
 *
 * A trace is an ordered list of events emitted while a program ran:
 *   const   x = <literal>
 *   compute x = f(a, b)          f in {add, sub, mul}
 *   if (c) ... else ... end      structured control flow
 *   output(x)                    an observable output
 *
 * Replaying a subset of events models "deleting events from the log":
 * dropped if/else/end markers remove control structure, dropped data
 * events remove their state writes. Reading an unwritten variable throws.
 */

export type BinOp = "add" | "sub" | "mul";

export type TraceEvent =
  | { op: "const"; out: string; value: number }
  | { op: "compute"; out: string; fn: BinOp; args: [string, string] }
  | { op: "if"; cond: string }
  | { op: "else" }
  | { op: "end" }
  | { op: "output"; arg: string };

/** Variables an event reads (empty for const/else/end). */
export function eventReads(ev: TraceEvent): string[] {
  switch (ev.op) {
    case "compute":
      return [...ev.args];
    case "if":
      return [ev.cond];
    case "output":
      return [ev.arg];
    default:
      return [];
  }
}

/** Variable an event writes, or null. */
export function eventWrites(ev: TraceEvent): string | null {
  return ev.op === "const" || ev.op === "compute" ? ev.out : null;
}

export function describeEvent(i: number, ev: TraceEvent): string {
  switch (ev.op) {
    case "const":
      return `#${i} ${ev.out} = ${ev.value}`;
    case "compute":
      return `#${i} ${ev.out} = ${ev.fn}(${ev.args[0]}, ${ev.args[1]})`;
    case "if":
      return `#${i} if (${ev.cond})`;
    case "else":
      return `#${i} else`;
    case "end":
      return `#${i} end`;
    case "output":
      return `#${i} output(${ev.arg})`;
  }
}

/** Static control-flow structure of a trace. */
export interface Structure {
  /** controllers[i] = indices of `if` events enclosing event i, outer first. */
  controllers: number[][];
  /** ifIndex -> matching else index (absent when the if has no else). */
  elseOf: Map<number, number>;
  /** ifIndex -> matching end index. */
  endOf: Map<number, number>;
  /** else/end index -> owning if index. */
  ifOf: Map<number, number>;
}

export function analyze(trace: TraceEvent[]): Structure {
  const controllers: number[][] = [];
  const elseOf = new Map<number, number>();
  const endOf = new Map<number, number>();
  const ifOf = new Map<number, number>();
  const stack: { ifIndex: number; sawElse: boolean }[] = [];
  trace.forEach((ev, i) => {
    controllers[i] = stack.map((f) => f.ifIndex);
    if (ev.op === "if") {
      stack.push({ ifIndex: i, sawElse: false });
    } else if (ev.op === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.sawElse) throw new Error(`event ${i}: unmatched else`);
      top.sawElse = true;
      elseOf.set(top.ifIndex, i);
      ifOf.set(i, top.ifIndex);
      controllers[i] = stack.slice(0, -1).map((f) => f.ifIndex);
    } else if (ev.op === "end") {
      const top = stack.pop();
      if (!top) throw new Error(`event ${i}: unmatched end`);
      endOf.set(top.ifIndex, i);
      ifOf.set(i, top.ifIndex);
      controllers[i] = stack.map((f) => f.ifIndex);
    }
  });
  if (stack.length > 0) throw new Error("unclosed if at end of trace");
  return { controllers, elseOf, endOf, ifOf };
}

export interface RunResult {
  /** output event index -> observed value. */
  outputs: Map<number, number>;
  /** executed[i] = event i was actually reached (control flow active). */
  executed: boolean[];
  /** final variable state. */
  finalState: Map<string, number>;
}

/**
 * Execute a trace, optionally keeping only the events in `keep`.
 * A valid keep-set keeps else/end markers exactly when their if is kept
 * (see projectMask in verify.ts); arbitrary sets are tolerated: a dropped
 * if simply removes its frame, so kept body events run unconditionally.
 */
export function replay(trace: TraceEvent[], keep?: ReadonlySet<number>): RunResult {
  const kept = (i: number): boolean => keep === undefined || keep.has(i);
  const state = new Map<string, number>();
  const outputs = new Map<number, number>();
  const executed = new Array<boolean>(trace.length).fill(false);
  const frames: { parentActive: boolean; cond: boolean; inElse: boolean }[] = [];
  const isActive = (): boolean =>
    frames.every((f) => (f.inElse ? f.parentActive && !f.cond : f.parentActive && f.cond));
  const readVar = (name: string, at: number): number => {
    const v = state.get(name);
    if (v === undefined) {
      throw new Error(`event ${at}: read of unwritten variable "${name}"`);
    }
    return v;
  };
  trace.forEach((ev, i) => {
    if (!kept(i)) return;
    if (ev.op === "if") {
      const parentActive = isActive();
      executed[i] = parentActive;
      const cond = parentActive ? readVar(ev.cond, i) !== 0 : false;
      frames.push({ parentActive, cond, inElse: false });
      return;
    }
    if (ev.op === "else") {
      const f = frames[frames.length - 1];
      if (!f) throw new Error(`event ${i}: else without if`);
      f.inElse = true;
      executed[i] = isActive();
      return;
    }
    if (ev.op === "end") {
      if (frames.pop() === undefined) throw new Error(`event ${i}: end without if`);
      executed[i] = isActive();
      return;
    }
    if (!isActive()) return;
    executed[i] = true;
    switch (ev.op) {
      case "const":
        state.set(ev.out, ev.value);
        break;
      case "compute": {
        const a = readVar(ev.args[0], i);
        const b = readVar(ev.args[1], i);
        state.set(ev.out, ev.fn === "add" ? a + b : ev.fn === "sub" ? a - b : a * b);
        break;
      }
      case "output":
        outputs.set(i, readVar(ev.arg, i));
        break;
    }
  });
  return { outputs, executed, finalState: state };
}
