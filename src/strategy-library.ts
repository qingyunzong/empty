import { createHash } from "node:crypto";

/** 一条策略规则：决议（decision）与来源（source）是必须可完全恢复的字段。 */
export interface Rule {
  id: string;
  decision: string;
  source: string;
}

/** 规则摘要：随差分条目记录，携带完整决议与来源以及内容哈希。 */
export interface RuleSummary {
  id: string;
  decision: string;
  source: string;
  hash: string;
}

export type DiffOp = "add" | "delete" | "update";

/** 差分条目：同一规则的前摘要（before）与后摘要（after）。 */
export interface DiffEntry {
  ruleId: string;
  op: DiffOp;
  before: RuleSummary | null;
  after: RuleSummary | null;
}

/** 差分：一组条目 + 应用前后两个快照的摘要指纹。 */
export interface Diff {
  entries: DiffEntry[];
  fromDigest: string;
  toDigest: string;
}

export type BatchOp =
  | { type: "put"; rule: Rule }
  | { type: "delete"; ruleId: string };

/** 不可变版本：追加式写入，历史版本永不修改。 */
export interface Version {
  id: number;
  digest: string;
  parent: number | null;
  diff: Diff;
}

export class DiffVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffVerificationError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function freezeRule(rule: Rule): Readonly<Rule> {
  return Object.freeze({ id: rule.id, decision: rule.decision, source: rule.source });
}

export function summarizeRule(rule: Rule): RuleSummary {
  return { id: rule.id, decision: rule.decision, source: rule.source, hash: sha256(canonical(rule)) };
}

function summaryEquals(a: RuleSummary | null, b: RuleSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.hash === b.hash && a.decision === b.decision && a.source === b.source && a.id === b.id;
}

/** 规则集合的内容指纹：与插入顺序无关。 */
export function digestOf(rules: ReadonlyMap<string, Readonly<Rule>>): string {
  const ordered = [...rules.keys()].sort().map((id) => rules.get(id) as Readonly<Rule>);
  return sha256(canonical(ordered));
}

function opOf(before: RuleSummary | null, after: RuleSummary | null): DiffOp {
  if (before === null) return "add";
  if (after === null) return "delete";
  return "update";
}

function sortEntries(entries: DiffEntry[]): DiffEntry[] {
  return entries.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}

/**
 * 先核后放：在基底副本上校验并应用差分。
 * 任一前置摘要不匹配、或结果指纹不符，都抛 DiffVerificationError，基底不被改动。
 */
export function applyDiffChecked(
  base: ReadonlyMap<string, Readonly<Rule>>,
  diff: Diff,
): Map<string, Readonly<Rule>> {
  const baseDigest = digestOf(base);
  if (baseDigest !== diff.fromDigest) {
    throw new DiffVerificationError(
      `base digest mismatch: expected ${diff.fromDigest}, got ${baseDigest}`,
    );
  }
  const next = new Map(base);
  for (const entry of diff.entries) {
    const current = next.get(entry.ruleId) ?? null;
    const currentSummary = current === null ? null : summarizeRule(current);
    if (!summaryEquals(currentSummary, entry.before)) {
      throw new DiffVerificationError(`before-summary mismatch for rule "${entry.ruleId}"`);
    }
    if (entry.after === null) {
      next.delete(entry.ruleId);
    } else {
      next.set(
        entry.ruleId,
        freezeRule({ id: entry.ruleId, decision: entry.after.decision, source: entry.after.source }),
      );
    }
  }
  const nextDigest = digestOf(next);
  if (nextDigest !== diff.toDigest) {
    throw new DiffVerificationError(`result digest mismatch: expected ${diff.toDigest}, got ${nextDigest}`);
  }
  return next;
}

/** 逆差分：条目倒序、前后摘要互换，用于逆发布。 */
export function invertDiff(diff: Diff): Diff {
  const entries = diff.entries
    .slice()
    .reverse()
    .map((entry) => ({
      ruleId: entry.ruleId,
      op: opOf(entry.after, entry.before),
      before: entry.after,
      after: entry.before,
    }));
  return { entries, fromDigest: diff.toDigest, toDigest: diff.fromDigest };
}

/** 差分复合：first 之后接 second，净效果合并为单个差分；净无变化的条目被消去。 */
export function composeDiffs(first: Diff, second: Diff): Diff {
  if (first.toDigest !== second.fromDigest) {
    throw new DiffVerificationError("diffs are not adjacent: cannot compose");
  }
  const byId = new Map<string, { before: RuleSummary | null; after: RuleSummary | null }>();
  for (const entry of first.entries) byId.set(entry.ruleId, { before: entry.before, after: entry.after });
  for (const entry of second.entries) {
    const prev = byId.get(entry.ruleId);
    if (prev === undefined) {
      byId.set(entry.ruleId, { before: entry.before, after: entry.after });
    } else {
      prev.after = entry.after;
    }
  }
  const entries: DiffEntry[] = [];
  for (const [ruleId, slot] of byId) {
    if (summaryEquals(slot.before, slot.after)) continue;
    entries.push({ ruleId, op: opOf(slot.before, slot.after), before: slot.before, after: slot.after });
  }
  return { entries: sortEntries(entries), fromDigest: first.fromDigest, toDigest: second.toDigest };
}

/** 读者快照：私有副本 + 冻结规则，热更不影响已持有的快照。 */
export class Snapshot {
  readonly versionId: number;
  readonly digest: string;
  private readonly rules: ReadonlyMap<string, Readonly<Rule>>;

  constructor(versionId: number, digest: string, rules: ReadonlyMap<string, Readonly<Rule>>) {
    this.versionId = versionId;
    this.digest = digest;
    this.rules = new Map(rules);
    Object.freeze(this);
  }

  get size(): number {
    return this.rules.size;
  }

  has(ruleId: string): boolean {
    return this.rules.has(ruleId);
  }

  getRule(ruleId: string): Readonly<Rule> | undefined {
    return this.rules.get(ruleId);
  }

  decide(ruleId: string): string | undefined {
    return this.rules.get(ruleId)?.decision;
  }

  listRules(): Readonly<Rule>[] {
    return [...this.rules.keys()].sort().map((id) => this.rules.get(id) as Readonly<Rule>);
  }
}

/**
 * 策略库：追加式版本日志。
 * - 批增删发布生成带前后摘要的差分；
 * - 逆发布先核后像，失败则历史不变；
 * - 历史版本只读，永不修改。
 */
export class StrategyLibrary {
  private readonly versions: Version[] = [];
  private readonly states: Map<number, ReadonlyMap<string, Readonly<Rule>>> = new Map();

  constructor() {
    const empty: ReadonlyMap<string, Readonly<Rule>> = new Map();
    const digest = digestOf(empty);
    this.versions.push(
      deepFreeze<Version>({ id: 0, digest, parent: null, diff: { entries: [], fromDigest: digest, toDigest: digest } }),
    );
    this.states.set(0, empty);
  }

  get head(): Version {
    return this.versions[this.versions.length - 1]!;
  }

  get versionCount(): number {
    return this.versions.length;
  }

  getVersion(id: number): Version {
    const version = this.versions[id];
    if (version === undefined) throw new RangeError(`unknown version: ${id}`);
    return version;
  }

  /** 读者快照：默认取当前头版本；返回独立副本，与后续热更隔离。 */
  getSnapshot(versionId?: number): Snapshot {
    const id = versionId ?? this.head.id;
    const version = this.getVersion(id);
    const rules = this.states.get(id);
    if (rules === undefined) throw new RangeError(`unknown version: ${id}`);
    return new Snapshot(version.id, version.digest, rules);
  }

  /** 批量增删改发布：生成带前后摘要的差分，追加新版本，历史不变。 */
  publish(ops: BatchOp[]): Version {
    const base = this.states.get(this.head.id) as ReadonlyMap<string, Readonly<Rule>>;
    const next = new Map(base);
    const acc = new Map<string, { before: RuleSummary | null; after: RuleSummary | null }>();

    for (const op of ops) {
      if (op.type === "put") {
        const rule = freezeRule(op.rule);
        const existing = next.get(rule.id) ?? null;
        const slot = acc.get(rule.id) ?? { before: existing === null ? null : summarizeRule(existing), after: null };
        slot.after = summarizeRule(rule);
        acc.set(rule.id, slot);
        next.set(rule.id, rule);
      } else {
        const existing = next.get(op.ruleId);
        if (existing === undefined) throw new Error(`cannot delete unknown rule: ${op.ruleId}`);
        const slot = acc.get(op.ruleId) ?? { before: summarizeRule(existing), after: null };
        slot.after = null;
        acc.set(op.ruleId, slot);
        next.delete(op.ruleId);
      }
    }

    const entries: DiffEntry[] = [];
    for (const [ruleId, slot] of acc) {
      if (summaryEquals(slot.before, slot.after)) continue;
      entries.push({ ruleId, op: opOf(slot.before, slot.after), before: slot.before, after: slot.after });
    }

    const diff: Diff = {
      entries: sortEntries(entries),
      fromDigest: digestOf(base),
      toDigest: digestOf(next),
    };
    // 发布自检：差分必须能把基底精确重放到新状态。
    applyDiffChecked(base, diff);
    return this.commit(diff, next);
  }

  /**
   * 逆发布：先核后像。
   * 核：把当前到头目标版本的差分链求逆，在临时副本上重放，
   *     校验结果指纹与目标历史版本一致（决议与来源完全恢复）；
   * 像：校验通过后才追加新版本；任何不一致都抛错且历史不变。
   */
  inversePublish(targetVersionId: number): Version {
    const target = this.getVersion(targetVersionId);
    if (target.id >= this.head.id) {
      throw new RangeError("inverse publish target must be an earlier version");
    }

    const chain: Diff[] = [];
    for (let v = target.id + 1; v <= this.head.id; v++) chain.push(this.versions[v]!.diff);
    let combined = chain[0]!;
    for (let i = 1; i < chain.length; i++) combined = composeDiffs(combined, chain[i]!);
    const inverse = invertDiff(combined);

    // 先核：仅在临时副本上重放并比对目标指纹。
    const current = this.states.get(this.head.id) as ReadonlyMap<string, Readonly<Rule>>;
    const restored = applyDiffChecked(current, inverse);
    if (digestOf(restored) !== target.digest) {
      throw new DiffVerificationError(`inverse publish verification failed against version ${target.id}`);
    }

    // 后像：核验通过，追加恢复出的新映像。
    return this.commit(inverse, restored);
  }

  private commit(diff: Diff, rules: Map<string, Readonly<Rule>>): Version {
    const version = deepFreeze<Version>({
      id: this.versions.length,
      digest: diff.toDigest,
      parent: this.head.id,
      diff,
    });
    this.versions.push(version);
    this.states.set(version.id, new Map(rules));
    return version;
  }
}
