import type { Rule } from './rewrite.js';

export interface InterpretOptions {
  readonly maxSteps: number;
  readonly maxLength?: number;
}

export interface InterpretResult {
  readonly states: readonly string[];
  readonly halted: boolean;
  readonly truncated: boolean;
}

const DEFAULT_MAX_LENGTH = 200_000;

function stepOnce(rules: readonly Rule[], input: string): string | null {
  for (let position = 0; position < input.length; position++) {
    let chosen: Rule | null = null;
    for (const rule of rules) {
      if (!input.startsWith(rule.lhs, position)) {
        continue;
      }
      if (
        chosen === null ||
        rule.lhs.length > chosen.lhs.length ||
        (rule.lhs.length === chosen.lhs.length && rule.id < chosen.id)
      ) {
        chosen = rule;
      }
    }
    if (chosen !== null) {
      return input.slice(0, position) + chosen.rhs + input.slice(position + chosen.lhs.length);
    }
  }
  return null;
}

export function interpret(rules: readonly Rule[], input: string, options: InterpretOptions): InterpretResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const states: string[] = [input];
  let current = input;
  for (let step = 0; step < options.maxSteps; step++) {
    const next = stepOnce(rules, current);
    if (next === null) {
      return { states, halted: true, truncated: false };
    }
    if (next.length > maxLength) {
      return { states, halted: false, truncated: true };
    }
    current = next;
    states.push(current);
  }
  return { states, halted: false, truncated: false };
}
