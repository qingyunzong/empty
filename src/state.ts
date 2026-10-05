/** Concrete states, small-step SC semantics, and the independence relation. */
import { CmpOp, Instr, Operand, Program } from './model';

export interface State {
  pcs: number[];                            // program counter per thread
  regs: Record<string, number>[];           // thread-local registers
  vars: Record<string, number>;             // shared integers
  mutexOwner: Record<string, number>;       // mutex -> owner thread id, -1 = free
}

export interface Violation {
  kind: 'assert' | 'model' | 'deadlock';
  message: string;
}

export function initialState(program: Program): State {
  const mutexOwner: Record<string, number> = {};
  for (const m of program.mutexes) mutexOwner[m] = -1;
  return {
    pcs: program.threads.map(() => 0),
    regs: program.threads.map(() => ({})),
    vars: { ...program.vars },
    mutexOwner,
  };
}

export function cloneState(s: State): State {
  return {
    pcs: [...s.pcs],
    regs: s.regs.map(r => ({ ...r })),
    vars: { ...s.vars },
    mutexOwner: { ...s.mutexOwner },
  };
}

export function nextInstr(program: Program, s: State, tid: number): Instr | null {
  const pc = s.pcs[tid];
  const instrs = program.threads[tid].instrs;
  return pc < instrs.length ? instrs[pc] : null;
}

/** A thread is enabled when it has a next instruction and is not blocked on a lock. */
export function isEnabled(program: Program, s: State, tid: number): boolean {
  const instr = nextInstr(program, s, tid);
  if (instr === null) return false;
  if (instr.op === 'lock' && s.mutexOwner[instr.mutex] !== -1) return false; // non-reentrant
  return true;
}

export function enabledThreads(program: Program, s: State): number[] {
  const out: number[] = [];
  for (let t = 0; t < program.threads.length; t++) {
    if (isEnabled(program, s, t)) out.push(t);
  }
  return out;
}

export function isFinished(program: Program, s: State, tid: number): boolean {
  return s.pcs[tid] >= program.threads[tid].instrs.length;
}

/** Deadlock: no thread enabled, but at least one thread is not finished. */
export function isDeadlock(program: Program, s: State): boolean {
  if (enabledThreads(program, s).length > 0) return false;
  return program.threads.some((_, t) => !isFinished(program, s, t));
}

function evalOperand(s: State, tid: number, o: Operand): number {
  return o.kind === 'const' ? o.value : s.regs[tid][o.name];
}

function evalCmp(cmp: CmpOp, a: number, b: number): boolean {
  switch (cmp) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
}

/**
 * Execute the next instruction of thread `tid` (must be enabled).
 * Returns the successor state, plus a violation if the step failed an
 * assertion or hit a modeling error (unlock of a mutex not owned).
 */
export function step(program: Program, s: State, tid: number): { next: State; violation: Violation | null } {
  const instr = nextInstr(program, s, tid);
  if (instr === null || !isEnabled(program, s, tid)) {
    throw new Error(`thread ${tid} is not enabled`);
  }
  const next = cloneState(s);
  next.pcs[tid]++;
  let violation: Violation | null = null;
  switch (instr.op) {
    case 'read':
      next.regs[tid][instr.reg] = s.vars[instr.variable];
      break;
    case 'write':
      next.vars[instr.variable] = evalOperand(s, tid, instr.value);
      break;
    case 'lock':
      next.mutexOwner[instr.mutex] = tid;
      break;
    case 'unlock':
      if (s.mutexOwner[instr.mutex] !== tid) {
        violation = { kind: 'model', message: `thread '${program.threads[tid].name}' unlocks mutex '${instr.mutex}' it does not own` };
      } else {
        next.mutexOwner[instr.mutex] = -1;
      }
      break;
    case 'assert': {
      const a = evalOperand(s, tid, instr.left);
      const b = evalOperand(s, tid, instr.right);
      if (!evalCmp(instr.cmp, a, b)) {
        violation = {
          kind: 'assert',
          message: `assertion failed in thread '${program.threads[tid].name}': ${a} ${instr.cmp} ${b} is false`,
        };
      }
      break;
    }
  }
  return { next, violation };
}

/** Canonical key for visited-state deduplication in the full exploration. */
export function stateKey(program: Program, s: State): string {
  const regKey = s.regs
    .map(r => Object.keys(r).sort().map(k => `${k}=${r[k]}`).join(','))
    .join('|');
  const varKey = Object.keys(program.vars).map(k => s.vars[k]).join(',');
  const mutexKey = program.mutexes.map(m => s.mutexOwner[m]).join(',');
  return `${s.pcs.join(',')};${regKey};${varKey};${mutexKey}`;
}

/**
 * Independence (for the swap-based reduction): two transitions by *different*
 * threads are dependent iff they touch the same mutex (lock/unlock) or the
 * same shared variable with at least one of them writing. Reads commute with
 * reads; asserts and register arithmetic are thread-local and commute with
 * everything.
 */
export function dependent(a: Instr, b: Instr): boolean {
  const sharedVar = (i: Instr): string | null =>
    i.op === 'read' || i.op === 'write' ? i.variable : null;
  const mutexOf = (i: Instr): string | null =>
    i.op === 'lock' || i.op === 'unlock' ? i.mutex : null;

  const ma = mutexOf(a);
  const mb = mutexOf(b);
  if (ma !== null || mb !== null) return ma !== null && mb !== null && ma === mb;

  const va = sharedVar(a);
  const vb = sharedVar(b);
  if (va === null || vb === null || va !== vb) return false;
  return a.op === 'write' || b.op === 'write';
}
