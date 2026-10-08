// Operational semantics and the independence relation used for compression.

import { Cmp, Expr, Instr, Program } from './lang.js';

export interface State {
  x: number;              // the shared integer
  lock: number | null;    // index of the thread holding the mutex, or null
  regs: number[][];       // regs[thread][1..4] (slot 0 unused)
  pc: number[];           // program counter per thread
}

export function initialState(p: Program): State {
  return {
    x: p.init,
    lock: null,
    regs: p.threads.map(() => [0, 0, 0, 0, 0]),
    pc: p.threads.map(() => 0),
  };
}

export function currentInstr(p: Program, s: State, t: number): Instr | null {
  return s.pc[t] < p.threads[t].instrs.length ? p.threads[t].instrs[s.pc[t]] : null;
}

export function isDone(p: Program, s: State, t: number): boolean {
  return s.pc[t] >= p.threads[t].instrs.length;
}

export function isEnabled(p: Program, s: State, t: number): boolean {
  const ins = currentInstr(p, s, t);
  if (!ins) return false;
  if (ins.kind === 'lock') return s.lock === null; // re-lock while holding blocks
  return true;
}

export function evalExpr(e: Expr, s: State, t: number): number {
  const b = e.base;
  const v = b.kind === 'const' ? b.value : b.kind === 'reg' ? s.regs[t][b.reg] : s.x;
  return v + e.delta;
}

function evalCmp(l: number, cmp: Cmp, r: number): boolean {
  switch (cmp) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
  }
}

export interface StepOutcome {
  state: State;
  error: string | null; // assertion failure or unlock-without-lock
}

export function applyStep(p: Program, s: State, t: number): StepOutcome {
  const ins = currentInstr(p, s, t);
  if (!ins) throw new Error(`thread ${t} already finished`);
  const ns: State = {
    x: s.x,
    lock: s.lock,
    regs: s.regs.map((r) => r.slice()),
    pc: s.pc.slice(),
  };
  ns.pc[t]++;
  switch (ins.kind) {
    case 'read':
      ns.regs[t][ins.reg] = s.x;
      break;
    case 'write':
      ns.x = evalExpr(ins.expr, s, t);
      break;
    case 'lock':
      ns.lock = t; // caller checked isEnabled
      break;
    case 'unlock':
      if (s.lock !== t) {
        return { state: ns, error: `unlock without holding the lock (held by ${s.lock === null ? 'nobody' : 't' + s.lock})` };
      }
      ns.lock = null;
      break;
    case 'assert': {
      const l = evalExpr(ins.left, s, t);
      const r = evalExpr(ins.right, s, t);
      if (!evalCmp(l, ins.cmp, r)) {
        return { state: ns, error: `assertion failed (${l} ${ins.cmp} ${r} is false)` };
      }
      break;
    }
  }
  return { state: ns, error: null };
}

// Independence relation for adjacent-step swapping (Mazurkiewicz traces).
// Conservative and syntactic: two instructions of *different* threads commute
// only if neither can change or observe a change of the shared state, i.e.
// both are pure readers (read / assert). Any write, lock or unlock is
// dependent with everything another thread does.
export function independent(a: Instr, b: Instr): boolean {
  const pure = (i: Instr) => i.kind === 'read' || i.kind === 'assert';
  return pure(a) && pure(b);
}
