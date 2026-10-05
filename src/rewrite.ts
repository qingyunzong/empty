/**
 * Deterministic string rewriting engine.
 *
 * Step selection order (single step):
 *   1. leftmost match position (each rule contributes its first occurrence)
 *   2. longest left-hand side
 *   3. smallest rule id
 *
 * Rules may grow or shrink the string. Every applied step records an
 * inverse delta (enough to undo the step) and per-character provenance
 * back to the original input. Full-state repetition is detected and
 * reported as cycle evidence. If the step budget is exhausted before
 * closure (normal form or cycle), the run is cross-checked against an
 * independent short-string interpreter.
 */

export interface Rule {
  id: number;
  lhs: string;
  rhs: string;
}

export type Origin =
  | { kind: 'original'; index: number }
  | { kind: 'produced'; ruleId: number; step: number };

export interface Token {
  ch: string;
  origin: Origin;
}

export interface InverseDelta {
  step: number;
  ruleId: number;
  position: number;
  removed: string;
  inserted: string;
}

export interface StepRecord extends InverseDelta {
  stateBefore: string;
  stateAfter: string;
}

export type RunStatus =
  | { kind: 'normal-form'; steps: number }
  | { kind: 'cycle'; steps: number; cycleStart: number; cycleLength: number }
  | { kind: 'budget-exhausted'; steps: number };

export interface CrossCheckReport {
  interpreterAgrees: boolean;
  firstDivergenceStep: number | null;
  undoRestoresOriginal: boolean;
}

export interface RunResult {
  status: RunStatus;
  initial: string;
  final: string;
  steps: StepRecord[];
  inverseDeltas: InverseDelta[];
  provenance: Token[];
  cycleEvidence: StepRecord[] | null;
  crossCheck: CrossCheckReport | null;
}

export interface RunOptions {
  budget: number;
  /** Cross-check with the naive interpreter when the budget is exhausted. Default true. */
  crossCheckOnBudgetExhaustion?: boolean;
}

export function validateRules(rules: readonly Rule[]): void {
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!Number.isInteger(rule.id)) {
      throw new Error(`rule id must be an integer, got ${rule.id}`);
    }
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id ${rule.id}`);
    }
    seen.add(rule.id);
    if (rule.lhs.length === 0) {
      throw new Error(`rule ${rule.id} has an empty left-hand side`);
    }
  }
}

export interface Match {
  rule: Rule;
  position: number;
}

/**
 * Pick the next match: leftmost position, then longest LHS, then smallest
 * rule id. Returns null when no rule matches (normal form reached).
 */
export function selectMatch(rules: readonly Rule[], state: string): Match | null {
  let best: Match | null = null;
  for (const rule of rules) {
    const position = state.indexOf(rule.lhs);
    if (position === -1) continue;
    if (
      best === null ||
      position < best.position ||
      (position === best.position && rule.lhs.length > best.rule.lhs.length) ||
      (position === best.position &&
        rule.lhs.length === best.rule.lhs.length &&
        rule.id < best.rule.id)
    ) {
      best = { rule, position };
    }
  }
  return best;
}

/** Undo a full history of inverse deltas, returning the reconstructed string. */
export function undoAll(finalState: string, deltas: readonly InverseDelta[]): string {
  let state = finalState;
  for (let i = deltas.length - 1; i >= 0; i--) {
    const d = deltas[i];
    if (state.slice(d.position, d.position + d.inserted.length) !== d.inserted) {
      throw new Error(
        `inverse delta at step ${d.step} does not apply: ` +
          `expected "${d.inserted}" at position ${d.position} of "${state}"`,
      );
    }
    state = state.slice(0, d.position) + d.removed + state.slice(d.position + d.inserted.length);
  }
  return state;
}

export function run(
  rules: readonly Rule[],
  input: string,
  options: RunOptions,
): RunResult {
  validateRules(rules);
  const crossCheckFlag = options.crossCheckOnBudgetExhaustion !== false;

  let state = input;
  let tokens: Token[] = [...input].map((ch, index) => ({
    ch,
    origin: { kind: 'original', index } as Origin,
  }));

  const steps: StepRecord[] = [];
  const seen = new Map<string, number>([[input, 0]]);
  let status: RunStatus | null = null;
  let cycleEvidence: StepRecord[] | null = null;

  for (let step = 1; ; step++) {
    const match = selectMatch(rules, state);
    if (match === null) {
      status = { kind: 'normal-form', steps: steps.length };
      break;
    }
    if (step > options.budget) {
      status = { kind: 'budget-exhausted', steps: steps.length };
      break;
    }

    const { rule, position } = match;
    const stateBefore = state;
    const removed = state.slice(position, position + rule.lhs.length);
    state =
      state.slice(0, position) + rule.rhs + state.slice(position + rule.lhs.length);

    const produced: Token[] = [...rule.rhs].map((ch) => ({
      ch,
      origin: { kind: 'produced', ruleId: rule.id, step } as Origin,
    }));
    tokens = [...tokens.slice(0, position), ...produced, ...tokens.slice(position + rule.lhs.length)];

    steps.push({
      step,
      ruleId: rule.id,
      position,
      removed,
      inserted: rule.rhs,
      stateBefore,
      stateAfter: state,
    });

    const previous = seen.get(state);
    if (previous !== undefined) {
      status = { kind: 'cycle', steps: steps.length, cycleStart: previous, cycleLength: step - previous };
      cycleEvidence = steps.slice(previous);
      break;
    }
    seen.set(state, step);
  }

  const inverseDeltas: InverseDelta[] = steps.map(
    ({ step, ruleId, position, removed, inserted }) => ({
      step,
      ruleId,
      position,
      removed,
      inserted,
    }),
  );

  let crossCheck: CrossCheckReport | null = null;
  if (status.kind === 'budget-exhausted' && crossCheckFlag) {
    crossCheck = crossCheckWithInterpreter(rules, input, steps);
  }

  return {
    status,
    initial: input,
    final: state,
    steps,
    inverseDeltas,
    provenance: tokens,
    cycleEvidence,
    crossCheck,
  };
}

function crossCheckWithInterpreter(
  rules: readonly Rule[],
  input: string,
  engineSteps: readonly StepRecord[],
): CrossCheckReport {
  const trajectory = interpretTrajectory(rules, input, engineSteps.length);
  let firstDivergenceStep: number | null = null;
  for (let i = 0; i < engineSteps.length; i++) {
    if (trajectory[i + 1] !== engineSteps[i].stateAfter) {
      firstDivergenceStep = engineSteps[i].step;
      break;
    }
  }
  let undoRestoresOriginal = false;
  try {
    undoRestoresOriginal = undoAll(
      engineSteps.length === 0 ? input : engineSteps[engineSteps.length - 1].stateAfter,
      engineSteps,
    ) === input;
  } catch {
    undoRestoresOriginal = false;
  }
  return {
    interpreterAgrees: firstDivergenceStep === null,
    firstDivergenceStep,
    undoRestoresOriginal,
  };
}

/**
 * Naive short-string interpreter: an independent, deliberately simple
 * implementation of the same selection semantics, operating on plain
 * strings only. Returns the state trajectory (index 0 = input).
 */
export function interpretTrajectory(
  rules: readonly Rule[],
  input: string,
  stepCount: number,
): string[] {
  validateRules(rules);
  const sorted = [...rules].sort(
    (a, b) => b.lhs.length - a.lhs.length || a.id - b.id,
  );
  const states = [input];
  let state = input;
  for (let n = 0; n < stepCount; n++) {
    let bestPos = -1;
    let best: Rule | null = null;
    for (const rule of sorted) {
      const pos = state.indexOf(rule.lhs);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        best = rule;
      }
    }
    if (best === null) break;
    state = state.slice(0, bestPos) + best.rhs + state.slice(bestPos + best.lhs.length);
    states.push(state);
  }
  return states;
}
