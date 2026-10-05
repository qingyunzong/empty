/**
 * Core planning model.
 *
 * State = up to 12 boolean bits (a bitmask) plus a vector of finite
 * resources. Actions have preconditions, unconditional effects and
 * conditional effects. All conditions (preconditions and conditional
 * effect triggers) are evaluated on the OLD state; all effects of one
 * action apply simultaneously. If the simultaneously triggered effects
 * both set and clear the same bit, the effects are mutex and the action
 * is REJECTED (not applicable) in that state.
 */

export const MAX_BITS = 12;

export interface ConditionalEffectDef {
  requireMask?: number; // bits that must be 1 in the OLD state
  forbidMask?: number;  // bits that must be 0 in the OLD state
  setMask?: number;
  clearMask?: number;
}

export interface ActionDef {
  name: string;
  requireMask?: number;
  forbidMask?: number;
  setMask?: number;
  clearMask?: number;
  cond?: ConditionalEffectDef[];
  cost?: Record<string, number>; // finite resource consumption
}

export interface ProblemDef {
  bits: number; // 1..MAX_BITS
  initial: number; // initial bitmask
  goal: { requireMask?: number; forbidMask?: number };
  resources?: Record<string, number>; // initial finite amounts
  actions: ActionDef[];
}

export interface NormCond {
  requireMask: number;
  forbidMask: number;
  setMask: number;
  clearMask: number;
}

export interface NormAction {
  name: string;
  index: number;
  requireMask: number;
  forbidMask: number;
  setMask: number;
  clearMask: number;
  cond: NormCond[];
  resCost: number[]; // aligned with Problem.resNames
}

export interface Problem {
  bits: number;
  fullMask: number;
  initial: number;
  goalRequire: number;
  goalForbid: number;
  resNames: string[];
  initialRes: number[];
  actions: NormAction[];
}

/** Search state: boolean bits plus remaining resources. */
export interface SState {
  bits: number;
  res: number[];
}

export function stateKey(bits: number, res: number[]): string {
  return res.length === 0 ? String(bits) : bits + "|" + res.join(",");
}

export class ProblemError extends Error {}

function checkMask(mask: number, bits: number, what: string): void {
  if (!Number.isInteger(mask) || mask < 0 || mask >= 1 << bits) {
    throw new ProblemError(
      `${what}: mask ${mask} out of range for ${bits} bits`
    );
  }
}

/** Validate and normalize a problem definition. Throws ProblemError. */
export function normalizeProblem(def: ProblemDef): Problem {
  if (!Number.isInteger(def.bits) || def.bits < 1 || def.bits > MAX_BITS) {
    throw new ProblemError(`bits must be an integer in 1..${MAX_BITS}`);
  }
  const bits = def.bits;
  const fullMask = (1 << bits) - 1;
  checkMask(def.initial, bits, "initial");

  const goalRequire = def.goal.requireMask ?? 0;
  const goalForbid = def.goal.forbidMask ?? 0;
  checkMask(goalRequire, bits, "goal.requireMask");
  checkMask(goalForbid, bits, "goal.forbidMask");
  if ((goalRequire & goalForbid) !== 0) {
    throw new ProblemError("goal requires and forbids the same bit");
  }

  const resNames = Object.keys(def.resources ?? {}).sort();
  const initialRes = resNames.map((n) => {
    const v = (def.resources ?? {})[n]!;
    if (!Number.isInteger(v) || v < 0) {
      throw new ProblemError(`resource ${n}: initial amount must be a non-negative integer`);
    }
    return v;
  });

  if (!Array.isArray(def.actions) || def.actions.length === 0) {
    throw new ProblemError("problem needs at least one action");
  }

  const actions: NormAction[] = def.actions.map((a, index) => {
    if (!a.name || typeof a.name !== "string") {
      throw new ProblemError(`action #${index}: missing name`);
    }
    const requireMask = a.requireMask ?? 0;
    const forbidMask = a.forbidMask ?? 0;
    const setMask = a.setMask ?? 0;
    const clearMask = a.clearMask ?? 0;
    for (const [what, m] of [
      ["requireMask", requireMask],
      ["forbidMask", forbidMask],
      ["setMask", setMask],
      ["clearMask", clearMask],
    ] as const) {
      checkMask(m, bits, `action ${a.name}: ${what}`);
    }
    if ((requireMask & forbidMask) !== 0) {
      throw new ProblemError(`action ${a.name}: precondition requires and forbids the same bit`);
    }
    if ((setMask & clearMask) !== 0) {
      // Static mutex: unconditional effects conflict in every state.
      throw new ProblemError(`action ${a.name}: unconditional effects set and clear the same bit`);
    }
    const cond: NormCond[] = (a.cond ?? []).map((c, ci) => {
      const nc: NormCond = {
        requireMask: c.requireMask ?? 0,
        forbidMask: c.forbidMask ?? 0,
        setMask: c.setMask ?? 0,
        clearMask: c.clearMask ?? 0,
      };
      for (const [what, m] of [
        ["requireMask", nc.requireMask],
        ["forbidMask", nc.forbidMask],
        ["setMask", nc.setMask],
        ["clearMask", nc.clearMask],
      ] as const) {
        checkMask(m, bits, `action ${a.name} cond[${ci}]: ${what}`);
      }
      if ((nc.requireMask & nc.forbidMask) !== 0) {
        throw new ProblemError(`action ${a.name} cond[${ci}]: trigger requires and forbids the same bit`);
      }
      if ((nc.setMask & nc.clearMask) !== 0) {
        throw new ProblemError(`action ${a.name} cond[${ci}]: sets and clears the same bit`);
      }
      return nc;
    });
    const resCost = resNames.map((n) => {
      const v = a.cost?.[n] ?? 0;
      if (!Number.isInteger(v) || v < 0) {
        throw new ProblemError(`action ${a.name}: cost of resource ${n} must be a non-negative integer`);
      }
      return v;
    });
    return { name: a.name, index, requireMask, forbidMask, setMask, clearMask, cond, resCost };
  });

  return { bits, fullMask, initial: def.initial, goalRequire, goalForbid, resNames, initialRes, actions };
}

export function initialState(p: Problem): SState {
  return { bits: p.initial, res: [...p.initialRes] };
}

export function isGoal(p: Problem, bits: number): boolean {
  return (bits & p.goalRequire) === p.goalRequire && (bits & p.goalForbid) === 0;
}

/**
 * Try to apply an action in a state.
 *
 * Semantics:
 *  - preconditions are checked on the OLD state;
 *  - conditional effect triggers are checked on the OLD state;
 *  - all triggered effects apply simultaneously;
 *  - if triggered effects set and clear the same bit (mutex), the action
 *    is rejected: returns null;
 *  - resources must suffice; they are consumed (never produced).
 *
 * Returns the successor state, or null if the action is not applicable.
 */
export function applyAction(p: Problem, s: SState, a: NormAction): SState | null {
  if ((s.bits & a.requireMask) !== a.requireMask) return null;
  if ((s.bits & a.forbidMask) !== 0) return null;
  for (let i = 0; i < p.resNames.length; i++) {
    if ((s.res[i] ?? 0) < (a.resCost[i] ?? 0)) return null;
  }
  let setMask = a.setMask;
  let clearMask = a.clearMask;
  for (const c of a.cond) {
    if ((s.bits & c.requireMask) === c.requireMask && (s.bits & c.forbidMask) === 0) {
      setMask |= c.setMask;
      clearMask |= c.clearMask;
    }
  }
  if ((setMask & clearMask) !== 0) return null; // mutex effects -> reject
  const bits = ((s.bits & ~clearMask) | setMask) & p.fullMask;
  const res = s.res.map((v, i) => v - (a.resCost[i] ?? 0));
  return { bits, res };
}

/** All applicable successors in deterministic (declaration) order. */
export function successors(p: Problem, s: SState): Array<{ action: NormAction; next: SState }> {
  const out: Array<{ action: NormAction; next: SState }> = [];
  for (const a of p.actions) {
    const next = applyAction(p, s, a);
    if (next) out.push({ action: a, next });
  }
  return out;
}
