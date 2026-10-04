import { interpret } from './interpreter.js';

export interface Rule {
  readonly id: string;
  readonly lhs: string;
  readonly rhs: string;
}

export interface Step {
  readonly index: number;
  readonly ruleId: string;
  readonly position: number;
  readonly removed: string;
  readonly inserted: string;
  readonly before: string;
  readonly after: string;
}

export interface CycleEvidence {
  readonly state: string;
  readonly firstSeenAt: number;
  readonly repeatedAt: number;
  readonly cycleLength: number;
  readonly cycleSteps: readonly Step[];
}

export interface Verification {
  readonly checked: boolean;
  readonly consistent: boolean;
  readonly comparedStates: number;
  readonly firstDivergence: number | null;
  readonly reason?: string;
}

export type Outcome =
  | { readonly kind: 'normal-form'; readonly steps: number }
  | { readonly kind: 'cycle'; readonly evidence: CycleEvidence }
  | { readonly kind: 'budget-exhausted'; readonly steps: number; readonly verification: Verification };

export interface Trace {
  readonly original: string;
  readonly steps: readonly Step[];
  readonly final: string;
  readonly outcome: Outcome;
}

export interface RewriteOptions {
  readonly maxSteps?: number;
  readonly verifyMaxLength?: number;
}

export const DEFAULT_MAX_STEPS = 10_000;
export const DEFAULT_VERIFY_MAX_LENGTH = 200_000;

export function validateRules(rules: readonly Rule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.id.length === 0) {
      throw new Error('rule id must be non-empty');
    }
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
    if (rule.lhs.length === 0) {
      throw new Error(`rule ${rule.id}: lhs must be non-empty`);
    }
  }
}

export interface Match {
  readonly rule: Rule;
  readonly position: number;
}

export function selectMatch(rules: readonly Rule[], input: string): Match | null {
  let best: Match | null = null;
  for (const rule of rules) {
    const position = input.indexOf(rule.lhs);
    if (position === -1) {
      continue;
    }
    if (
      best === null ||
      position < best.position ||
      (position === best.position && rule.lhs.length > best.rule.lhs.length) ||
      (position === best.position && rule.lhs.length === best.rule.lhs.length && rule.id < best.rule.id)
    ) {
      best = { rule, position };
    }
  }
  return best;
}

export function applyMatch(input: string, match: Match): string {
  const { rule, position } = match;
  return input.slice(0, position) + rule.rhs + input.slice(position + rule.lhs.length);
}

function makeTrace(original: string, steps: Step[], outcome: Outcome): Trace {
  const last = steps[steps.length - 1];
  return { original, steps, final: last === undefined ? original : last.after, outcome };
}

export function verifyTraceWithInterpreter(
  rules: readonly Rule[],
  trace: Trace,
  maxSteps: number,
  verifyMaxLength: number = DEFAULT_VERIFY_MAX_LENGTH,
): Verification {
  const states: string[] = [trace.original];
  for (const step of trace.steps) {
    states.push(step.after);
  }
  const result = interpret(rules, trace.original, { maxSteps, maxLength: verifyMaxLength });
  if (result.truncated) {
    return {
      checked: false,
      consistent: false,
      comparedStates: 0,
      firstDivergence: null,
      reason: `interpreter aborted: state exceeded ${verifyMaxLength} chars`,
    };
  }
  let firstDivergence: number | null = null;
  const compared = Math.min(states.length, result.states.length);
  for (let i = 0; i < compared; i++) {
    if (states[i] !== result.states[i]) {
      firstDivergence = i;
      break;
    }
  }
  const consistent =
    firstDivergence === null &&
    states.length === result.states.length &&
    result.halted === (trace.outcome.kind === 'normal-form');
  return { checked: true, consistent, comparedStates: compared, firstDivergence };
}

export function rewrite(rules: readonly Rule[], input: string, options: RewriteOptions = {}): Trace {
  validateRules(rules);
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error(`maxSteps must be a non-negative integer, got ${maxSteps}`);
  }
  const seen = new Map<string, number>();
  const steps: Step[] = [];
  let current = input;
  seen.set(current, 0);

  for (let index = 0; index < maxSteps; index++) {
    const match = selectMatch(rules, current);
    if (match === null) {
      return makeTrace(input, steps, { kind: 'normal-form', steps: steps.length });
    }
    const before = current;
    const after = applyMatch(before, match);
    steps.push({
      index,
      ruleId: match.rule.id,
      position: match.position,
      removed: match.rule.lhs,
      inserted: match.rule.rhs,
      before,
      after,
    });
    current = after;
    const stateIndex = steps.length;
    const firstSeen = seen.get(current);
    if (firstSeen !== undefined) {
      const evidence: CycleEvidence = {
        state: current,
        firstSeenAt: firstSeen,
        repeatedAt: stateIndex,
        cycleLength: stateIndex - firstSeen,
        cycleSteps: steps.slice(firstSeen),
      };
      return makeTrace(input, steps, { kind: 'cycle', evidence });
    }
    seen.set(current, stateIndex);
  }

  const trace = makeTrace(input, steps, {
    kind: 'budget-exhausted',
    steps: steps.length,
    verification: {
      checked: false,
      consistent: false,
      comparedStates: 0,
      firstDivergence: null,
      reason: 'verification not run',
    },
  });
  const verification = verifyTraceWithInterpreter(rules, trace, maxSteps, options.verifyMaxLength);
  return makeTrace(input, steps, { kind: 'budget-exhausted', steps: steps.length, verification });
}

export function undo(trace: Trace): string {
  let current = trace.final;
  for (let i = trace.steps.length - 1; i >= 0; i--) {
    const step = trace.steps[i];
    if (step === undefined || !current.startsWith(step.inserted, step.position)) {
      throw new Error(`trace inconsistent at step ${step?.index ?? i}`);
    }
    current = current.slice(0, step.position) + step.removed + current.slice(step.position + step.inserted.length);
  }
  return current;
}

export function stateAt(trace: Trace, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > trace.steps.length) {
    throw new RangeError(`state index ${index} out of range 0..${trace.steps.length}`);
  }
  let current = trace.original;
  for (let i = 0; i < index; i++) {
    const step = trace.steps[i];
    if (step === undefined) {
      throw new Error(`trace missing step ${i}`);
    }
    current = current.slice(0, step.position) + step.inserted + current.slice(step.position + step.removed.length);
  }
  return current;
}
