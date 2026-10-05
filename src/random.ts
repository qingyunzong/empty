import { TxMachine } from './machine';
import { State } from './util';

export type Op =
  | { kind: 'set'; name: string; value: number }
  | { kind: 'add'; name: string; delta: number }
  | { kind: 'mul'; name: string; factor: number }
  | { kind: 'begin' }
  | { kind: 'commit' }
  | { kind: 'rollback' }
  | { kind: 'stage'; action: string }
  | { kind: 'throw' }
  | { kind: 'capture'; body: Op[] };

export interface Program {
  budget: number | null;
  ops: Op[];
}

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VARS = ['a', 'b', 'c', 'd'];
const MAX_CAPTURE_NEST = 3;

function pickVar(rng: () => number): string {
  return VARS[Math.floor(rng() * VARS.length)];
}

function genInt(rng: () => number): number {
  return Math.floor(rng() * 41) - 20;
}

function pickBudget(rng: () => number): number | null {
  if (rng() < 0.3) {
    return null;
  }
  return Math.floor(rng() * 90);
}

function genOps(
  rng: () => number,
  count: number,
  simDepth: number,
  nest: number,
): { ops: Op[]; depth: number } {
  const ops: Op[] = [];
  let depth = simDepth;
  for (let i = 0; i < count; i += 1) {
    const r = rng();
    if (r < 0.22) {
      ops.push({ kind: 'set', name: pickVar(rng), value: genInt(rng) });
    } else if (r < 0.4) {
      ops.push({ kind: 'add', name: pickVar(rng), delta: genInt(rng) });
    } else if (r < 0.48) {
      ops.push({ kind: 'mul', name: pickVar(rng), factor: Math.floor(rng() * 7) - 3 });
    } else if (r < 0.57) {
      ops.push({ kind: 'begin' });
      depth += 1;
    } else if (r < 0.67) {
      if (depth > 1 || rng() < 0.05) {
        ops.push({ kind: 'commit' });
        depth -= 1;
      }
    } else if (r < 0.75) {
      if (depth > 1 || rng() < 0.03) {
        ops.push({ kind: 'rollback' });
        depth -= 1;
      }
    } else if (r < 0.86) {
      ops.push({ kind: 'stage', action: `act-${Math.floor(rng() * 1000)}` });
    } else if (nest < MAX_CAPTURE_NEST) {
      const bodyCount = 1 + Math.floor(rng() * 6);
      const inner = genOps(rng, bodyCount, depth + 1, nest + 1);
      const body = inner.ops;
      if (rng() < 0.35) {
        body.push({ kind: 'throw' });
      }
      ops.push({ kind: 'capture', body });
      depth = Math.max(0, inner.depth - 1);
    }
  }
  return { ops, depth };
}

export function generateProgram(rng: () => number): Program {
  const budget = pickBudget(rng);
  const total = 20 + Math.floor(rng() * 40);
  const { ops } = genOps(rng, total, 1, 0);
  return { budget, ops };
}

export interface Outcome {
  ok: boolean;
  error: string | null;
  state: State;
  published: string[];
  captured: string[];
  budgetLeft: number | null;
  depth: number;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}

function execOp(machine: TxMachine, op: Op, captured: string[]): void {
  switch (op.kind) {
    case 'set':
      machine.set(op.name, op.value);
      break;
    case 'add':
      machine.add(op.name, op.delta);
      break;
    case 'mul':
      machine.mul(op.name, op.factor);
      break;
    case 'begin':
      machine.begin();
      break;
    case 'commit':
      machine.commit();
      break;
    case 'rollback':
      machine.rollback();
      break;
    case 'stage':
      machine.stage(op.action);
      break;
    case 'throw':
      throw new Error('boom');
    case 'capture': {
      const result = machine.capture(() => {
        for (const sub of op.body) {
          execOp(machine, sub, captured);
        }
      });
      captured.push(result.ok ? 'ok' : errorName(result.error));
      break;
    }
  }
}

export function execute(machine: TxMachine, program: Program): Outcome {
  const captured: string[] = [];
  let ok = true;
  let error: string | null = null;
  try {
    machine.run(() => {
      for (const op of program.ops) {
        execOp(machine, op, captured);
      }
    }, { budget: program.budget });
  } catch (e) {
    ok = false;
    error = errorName(e);
  }
  return {
    ok,
    error,
    state: machine.snapshot(),
    published: [...machine.published],
    captured,
    budgetLeft: machine.budgetLeft,
    depth: machine.depth,
  };
}
