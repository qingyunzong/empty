export const SENSITIVITY_ORDER = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

export type Sensitivity = (typeof SENSITIVITY_ORDER)[number];

export type TransformKind = "concat" | "hash" | "tokenize" | "aggregate";

export type LabelSource =
  | { kind: "manual"; annotator: string; at?: string }
  | { kind: "scanner"; scanner: string; pattern?: string }
  | { kind: "lineage"; transform: TransformKind }
  | { kind: "merged"; of: LabelSource[] };

export interface PurposeRestriction {
  /** 若为非空数组，则仅允许这些用途；空数组表示不限制。 */
  allowed: string[];
  /** 显式禁止的用途，优先级高于 allowed。 */
  denied: string[];
}

export interface DeclassifyRule {
  /** 触发该规则的变换。 */
  transform: TransformKind;
  action: "keep" | "downgrade" | "drop";
  /** downgrade 时的目标级别，必须不高于当前级别。 */
  toLevel?: Sensitivity;
  /** 可选的置信度系数，默认 1。 */
  confidenceFactor?: number;
}

export type LabelScope = "record" | "cohort" | "dataset";

export interface Label {
  id: string;
  /** 同一 category 内的标签按 level 构成全序；不同 category 之间不可比较。 */
  category: string;
  level: Sensitivity;
  scope: LabelScope;
  source: LabelSource;
  /** 0..1 */
  confidence: number;
  purposes: PurposeRestriction;
  declassify: DeclassifyRule[];
}

export function levelRank(level: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(level);
}

/**
 * 偏序比较：同 category 按 level 比较，不同 category 不可比较返回 null。
 */
export function compareLabels(a: Label, b: Label): -1 | 0 | 1 | null {
  if (a.category !== b.category) return null;
  const ra = levelRank(a.level);
  const rb = levelRank(b.level);
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function mergeSources(a: LabelSource, b: LabelSource): LabelSource {
  const of: LabelSource[] = [];
  for (const s of [a, b]) {
    if (s.kind === "merged") of.push(...s.of);
    else of.push(s);
  }
  return { kind: "merged", of };
}

function mergeDeclassify(a: DeclassifyRule[], b: DeclassifyRule[]): DeclassifyRule[] {
  const byTransform = new Map<TransformKind, DeclassifyRule>();
  for (const rule of [...a, ...b]) {
    const existing = byTransform.get(rule.transform);
    if (!existing) {
      byTransform.set(rule.transform, { ...rule });
      continue;
    }
    // 同一变换的多条规则取更保守者：drop > downgrade > keep。
    const rank = { drop: 2, downgrade: 1, keep: 0 } as const;
    byTransform.set(
      rule.transform,
      rank[rule.action] >= rank[existing.action] ? { ...rule } : existing,
    );
  }
  return [...byTransform.values()];
}

/** 合并同一 id 的重复标签：置信度取 max，用途限制取交集/并集，来源合并。 */
export function mergeDuplicate(label: Label, other: Label): Label {
  if (label.id !== other.id) throw new Error(`cannot merge ${label.id} with ${other.id}`);
  return {
    ...label,
    level: levelRank(label.level) >= levelRank(other.level) ? label.level : other.level,
    confidence: Math.max(label.confidence, other.confidence),
    source: mergeSources(label.source, other.source),
    purposes: {
      allowed:
        label.purposes.allowed.length === 0
          ? other.purposes.allowed
          : other.purposes.allowed.length === 0
            ? label.purposes.allowed
            : intersect(label.purposes.allowed, other.purposes.allowed),
      denied: union(label.purposes.denied, other.purposes.denied),
    },
    declassify: mergeDeclassify(label.declassify, other.declassify),
  };
}

/**
 * 冲突消解：先按 id 合并重复，再按偏序保留所有极大元素。
 * 不同 category 的标签不可比较，因此可同时保留多个最大元素。
 */
export function resolveConflicts(labels: Label[]): Label[] {
  const byId = new Map<string, Label>();
  for (const label of labels) {
    const existing = byId.get(label.id);
    byId.set(label.id, existing ? mergeDuplicate(existing, label) : { ...label });
  }
  const merged = [...byId.values()];
  return merged.filter(
    (a) => !merged.some((b) => b !== a && compareLabels(a, b) === -1),
  );
}
