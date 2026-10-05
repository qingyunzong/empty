import { evalCondition, type Condition, type Row } from './conditions.js';
import type { TV } from './trivalent.js';

export type Effect = 'allow' | 'deny';

export interface Rule {
  name: string;
  when: Condition;
  effect: Effect;
}

export interface FieldPolicy {
  field: string;
  when: Condition;
}

export interface Policy {
  rules: Rule[];
  default: Effect;
  fields?: FieldPolicy[];
}

export function evalPolicy(policy: Policy, row: Row): TV {
  let sawAllow = false;
  let sawUnknown = false;
  for (const rule of policy.rules) {
    const c = evalCondition(rule.when, row);
    if (c === 'allow') {
      if (rule.effect === 'deny') return 'deny';
      sawAllow = true;
    } else if (c === 'unknown') {
      sawUnknown = true;
    }
  }
  if (sawUnknown) return 'unknown';
  if (sawAllow) return 'allow';
  return policy.default;
}

export function evalFieldPolicy(field: FieldPolicy, row: Row): TV {
  return evalCondition(field.when, row);
}
