import { byId, Rule, Summary } from './rules';

export interface RuleDiff {
  readonly before: Summary;
  readonly after: Summary;
  readonly added: readonly Rule[];
  readonly removed: readonly Rule[];
}

export function invertDiff(diff: RuleDiff): RuleDiff {
  return {
    before: diff.after,
    after: diff.before,
    added: diff.removed,
    removed: diff.added,
  };
}

export function composeDiffs(first: RuleDiff, second: RuleDiff): RuleDiff {
  if (first.after.hash !== second.before.hash) {
    throw new Error('diffs are not adjacent: first.after does not match second.before');
  }
  const removedInSecond = new Set(second.removed.map((rule) => rule.id));
  const addedInSecond = new Set(second.added.map((rule) => rule.id));
  const added = [
    ...first.added.filter((rule) => !removedInSecond.has(rule.id)),
    ...second.added,
  ].sort(byId);
  const removed = [
    ...first.removed.filter((rule) => !addedInSecond.has(rule.id)),
    ...second.removed,
  ].sort(byId);
  return { before: first.before, after: second.after, added, removed };
}
