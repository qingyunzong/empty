import { invertDiff, RuleDiff } from './diff';
import { byId, Rule, sameSummary, summarize, Summary } from './rules';

export type BatchOp =
  | { readonly kind: 'add'; readonly rule: Rule }
  | { readonly kind: 'delete'; readonly id: string };

export interface Version {
  readonly seq: number;
  readonly rules: ReadonlyMap<string, Rule>;
  readonly summary: Summary;
}

export class DiffVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffVerificationError';
  }
}

function immutableView(rules: Map<string, Rule>): ReadonlyMap<string, Rule> {
  const view: ReadonlyMap<string, Rule> = {
    get size() {
      return rules.size;
    },
    get: (id: string) => rules.get(id),
    has: (id: string) => rules.has(id),
    keys: () => rules.keys(),
    values: () => rules.values(),
    entries: () => rules.entries(),
    forEach: (callback, thisArg) => rules.forEach(callback, thisArg),
    [Symbol.iterator]: () => rules[Symbol.iterator](),
  };
  return Object.freeze(view);
}

export class Snapshot {
  constructor(private readonly pinned: Version) {}

  get seq(): number {
    return this.pinned.seq;
  }

  get summary(): Summary {
    return this.pinned.summary;
  }

  get(id: string): Rule | undefined {
    return this.pinned.rules.get(id);
  }

  has(id: string): boolean {
    return this.pinned.rules.has(id);
  }

  list(): Rule[] {
    return [...this.pinned.rules.values()].sort(byId);
  }
}

export class PolicyStore {
  private readonly history: Version[] = [];

  constructor() {
    const rules = new Map<string, Rule>();
    this.history.push({
      seq: 0,
      rules: immutableView(rules),
      summary: summarize(rules),
    });
  }

  get current(): Version {
    const tip = this.history[this.history.length - 1];
    if (tip === undefined) throw new Error('store has no version');
    return tip;
  }

  get length(): number {
    return this.history.length;
  }

  version(seq: number): Version {
    const found = this.history[seq];
    if (found === undefined) throw new RangeError(`no version with seq ${seq}`);
    return found;
  }

  plan(batch: readonly BatchOp[]): RuleDiff {
    const base = this.current;
    const next = new Map(base.rules);
    const pendingAdds = new Map<string, Rule>();
    const removed: Rule[] = [];
    for (const op of batch) {
      if (op.kind === 'add') {
        if (next.has(op.rule.id)) {
          throw new Error(`duplicate rule id: ${op.rule.id}`);
        }
        const rule: Rule = Object.freeze({ ...op.rule });
        next.set(rule.id, rule);
        pendingAdds.set(rule.id, rule);
      } else {
        const pending = pendingAdds.get(op.id);
        if (pending !== undefined) {
          pendingAdds.delete(op.id);
          next.delete(op.id);
          continue;
        }
        const existing = next.get(op.id);
        if (existing === undefined) {
          throw new Error(`unknown rule id: ${op.id}`);
        }
        next.delete(op.id);
        removed.push(existing);
      }
    }
    const added = [...pendingAdds.values()];
    added.sort(byId);
    removed.sort(byId);
    return { before: base.summary, after: summarize(next), added, removed };
  }

  publish(diff: RuleDiff): Version {
    const base = this.current;
    if (!sameSummary(diff.before, base.summary)) {
      throw new DiffVerificationError(
        `diff before-summary does not match current version ${base.seq}`,
      );
    }
    const next = new Map(base.rules);
    for (const rule of diff.removed) {
      if (!next.delete(rule.id)) {
        throw new DiffVerificationError(`cannot remove absent rule id: ${rule.id}`);
      }
    }
    for (const rule of diff.added) {
      if (next.has(rule.id)) {
        throw new DiffVerificationError(`cannot add existing rule id: ${rule.id}`);
      }
      next.set(rule.id, Object.freeze({ ...rule }));
    }
    const summary = summarize(next);
    if (!sameSummary(summary, diff.after)) {
      throw new DiffVerificationError(
        'materialized image does not match diff after-summary',
      );
    }
    const version: Version = Object.freeze({
      seq: base.seq + 1,
      rules: immutableView(next),
      summary,
    });
    this.history.push(version);
    return version;
  }

  unpublish(diff: RuleDiff): Version {
    return this.publish(invertDiff(diff));
  }

  snapshot(): Snapshot {
    return new Snapshot(this.current);
  }
}
