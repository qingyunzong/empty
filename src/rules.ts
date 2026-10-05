import { createHash } from 'node:crypto';

export type Decision = 'allow' | 'deny' | 'audit';

export interface Rule {
  readonly id: string;
  readonly decision: Decision;
  readonly source: string;
  readonly pattern: string;
}

export function canonicalRule(rule: Rule): string {
  return JSON.stringify([rule.id, rule.decision, rule.source, rule.pattern]);
}

export interface Summary {
  readonly ruleCount: number;
  readonly decisions: Readonly<Record<string, number>>;
  readonly sources: Readonly<Record<string, number>>;
  readonly hash: string;
}

export function summarize(rules: ReadonlyMap<string, Rule>): Summary {
  const ids = [...rules.keys()].sort();
  const decisions: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const hash = createHash('sha256');
  for (const id of ids) {
    const rule = rules.get(id);
    if (rule === undefined) continue;
    decisions[rule.decision] = (decisions[rule.decision] ?? 0) + 1;
    sources[rule.source] = (sources[rule.source] ?? 0) + 1;
    hash.update(canonicalRule(rule));
    hash.update('\n');
  }
  return {
    ruleCount: ids.length,
    decisions: Object.freeze(decisions),
    sources: Object.freeze(sources),
    hash: hash.digest('hex'),
  };
}

export function sameSummary(a: Summary, b: Summary): boolean {
  return a.hash === b.hash && a.ruleCount === b.ruleCount;
}

export function byId(a: Rule, b: Rule): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
