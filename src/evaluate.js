import { run } from './vm.js';

export const LEVEL_RANK = { global: 0, channel: 1, merchant: 2 };
export const DECISION_RANK = { allow: 0, review: 1, deny: 2 };

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function evaluateRuleset(ruleset, event) {
  const fired = [];
  for (const rule of ruleset.rules) {
    if (rule.match) {
      const actual = rule.match.field === 'channel' ? event.channel : event.merchant;
      if (actual !== rule.match.value) continue;
    }
    for (const stmt of rule.statements) {
      if (run(stmt.program, ruleset.consts, event)) {
        fired.push({
          rule: rule.name, level: rule.level, statement: stmt.index,
          decision: stmt.decision, override: stmt.override,
        });
      }
    }
  }
  // Outer deny wins by construction: the strictest fired decision prevails.
  let decision = 'allow';
  for (const f of fired)
    if (DECISION_RANK[f.decision] > DECISION_RANK[decision]) decision = f.decision;
  // All tied strictest rules are listed, in a stable deterministic order.
  const matched = fired
    .filter((f) => f.decision === decision)
    .sort((a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
      || cmpStr(a.rule, b.rule)
      || a.statement - b.statement);
  // A pending manual review is never treated as a pass.
  const outcome = decision === 'review'
    ? (event.review === 'approved' ? 'allow' : event.review === 'rejected' ? 'deny' : 'review')
    : decision;
  return { decision, outcome, matched, fired };
}
