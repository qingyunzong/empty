/**
 * event-stats: 按事件 ID 维护多维标签组合计数的统计库。
 *
 * 设计要点：
 * - 每次更正（correct）= 撤旧 + 加新，在私有副本上完成后通过单次引用替换原子发布；
 *   旧快照不受影响，持旧快照的读者永远看到一致状态。
 * - 空标签（""）与缺失标签（维度键不存在）严格区分：投影单元中缺失维度编码为 null。
 * - 查询为任意维度子集（0..4 维）的投影计数，按去重后的标签组合聚合（非逐条扫描）。
 * - verify() 用全部事件逐条投影暴力重算，与索引结果核对。
 */

/** 一个事件的多维标签：维度名 -> 标签值。值允许为空字符串。 */
export type Labels = Readonly<Record<string, string>>;

/** 投影单元中某一维的取值；null 表示该事件缺失此维度（与 "" 不同）。 */
export type CellValue = string | null;

export const MAX_PROJECTION_DIMS = 4;

/** 规范化标签：校验类型、冻结副本。空字符串值合法，空维度名非法。 */
export function normalizeLabels(labels: Labels): Labels {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    throw new TypeError("labels must be a plain object of string -> string");
  }
  const out: Record<string, string> = {};
  for (const [dim, value] of Object.entries(labels)) {
    if (dim.length === 0) throw new TypeError("dimension name must be non-empty");
    if (typeof value !== "string") {
      throw new TypeError(`label value for dimension "${dim}" must be a string`);
    }
    out[dim] = value;
  }
  return Object.freeze(out);
}

/** 完整标签组合的规范键：按维度名排序的 [dim, value] 对 JSON 编码。 */
export function comboKeyOf(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** 规范化投影维度：去重、排序、校验数量上限。返回排序后的维度数组。 */
export function normalizeDims(dims: readonly string[]): string[] {
  if (!Array.isArray(dims)) throw new TypeError("dims must be an array of dimension names");
  const unique = [...new Set(dims)];
  for (const d of unique) {
    if (typeof d !== "string" || d.length === 0) {
      throw new TypeError("dimension names must be non-empty strings");
    }
  }
  if (unique.length > MAX_PROJECTION_DIMS) {
    throw new RangeError(`projection supports at most ${MAX_PROJECTION_DIMS} dimensions, got ${unique.length}`);
  }
  return unique.sort();
}

/** 投影单元键：按排序后维度顺序的取值数组 JSON 编码，缺失维度为 null。 */
export function encodeCell(values: readonly CellValue[]): string {
  return JSON.stringify(values);
}

export function decodeCell(key: string): CellValue[] {
  return JSON.parse(key) as CellValue[];
}

/** verify() 发现的不一致项。 */
export interface ProjectionMismatch {
  readonly dims: readonly string[];
  readonly cellKey: string;
  readonly cell: CellValue[];
  /** 索引（project）给出的计数。 */
  readonly indexed: number;
  /** 逐条事件投影暴力重算的计数。 */
  readonly bruteForce: number;
}

/** 稀疏差分条目：仅包含计数发生变化的投影单元。 */
export interface DiffEntry {
  readonly cellKey: string;
  readonly cell: CellValue[];
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

/**
 * 不可变快照。发布后内容不再变化；projectionCache 仅为幂等记忆化，
 * 不改变可观察状态。
 */
export class Snapshot {
  readonly version: number;
  /** eventId -> 完整组合键 */
  readonly #events: ReadonlyMap<string, string>;
  /** 完整组合键 -> 规范化标签 */
  readonly #combos: ReadonlyMap<string, Labels>;
  /** 完整组合键 -> 事件数 */
  readonly #comboCounts: ReadonlyMap<string, number>;
  /** 维度集键 -> 投影结果（记忆化缓存） */
  readonly #projectionCache = new Map<string, Map<string, number>>();

  constructor(
    version: number,
    events: ReadonlyMap<string, string>,
    combos: ReadonlyMap<string, Labels>,
    comboCounts: ReadonlyMap<string, number>,
  ) {
    this.version = version;
    this.#events = events;
    this.#combos = combos;
    this.#comboCounts = comboCounts;
  }

  get eventCount(): number {
    return this.#events.size;
  }

  /** eventId 对应的完整组合键；不存在返回 undefined。 */
  eventKey(eventId: string): string | undefined {
    return this.#events.get(eventId);
  }

  /** 某事件的规范化标签；不存在返回 undefined。 */
  labelsOf(eventId: string): Labels | undefined {
    const key = this.#events.get(eventId);
    return key === undefined ? undefined : this.#combos.get(key);
  }

  /** 内部复制用：eventId -> 完整组合键。 */
  snapshotEvents(): ReadonlyMap<string, string> {
    return this.#events;
  }

  /** 内部复制用：完整组合键 -> 规范化标签。 */
  snapshotCombos(): ReadonlyMap<string, Labels> {
    return this.#combos;
  }

  /** 完整标签组合 -> 计数（键为 comboKeyOf 编码）。 */
  comboCounts(): ReadonlyMap<string, number> {
    return this.#comboCounts;
  }

  /**
   * 投影查询：按 dims（0..4 维，自动去重排序）聚合计数。
   * 返回 单元键 -> 计数；单元键用 decodeCell 解码，缺失维度为 null。
   * 按去重后的标签组合聚合，不逐条扫描事件。
   */
  project(dims: readonly string[]): Map<string, number> {
    const sorted = normalizeDims(dims);
    const dimKey = JSON.stringify(sorted);
    const cached = this.#projectionCache.get(dimKey);
    if (cached) return new Map(cached);

    const result = new Map<string, number>();
    for (const [comboKey, count] of this.#comboCounts) {
      const labels = this.#combos.get(comboKey)!;
      const cell = encodeCell(
        sorted.map((d) => (Object.hasOwn(labels, d) ? labels[d]! : null)),
      );
      result.set(cell, (result.get(cell) ?? 0) + count);
    }
    this.#projectionCache.set(dimKey, result);
    return new Map(result);
  }

  /**
   * 核对：用全部事件逐条投影暴力重算，与 project() 的索引结果对比。
   * 返回不一致列表；空数组表示核对通过。
   */
  verify(dims: readonly string[]): ProjectionMismatch[] {
    const sorted = normalizeDims(dims);
    const expected = new Map<string, number>();
    for (const comboKey of this.#events.values()) {
      const labels = this.#combos.get(comboKey)!;
      const cell = encodeCell(
        sorted.map((d) => (Object.hasOwn(labels, d) ? labels[d]! : null)),
      );
      expected.set(cell, (expected.get(cell) ?? 0) + 1);
    }
    const actual = this.project(sorted);
    const mismatches: ProjectionMismatch[] = [];
    for (const key of new Set([...expected.keys(), ...actual.keys()])) {
      const bruteForce = expected.get(key) ?? 0;
      const indexed = actual.get(key) ?? 0;
      if (bruteForce !== indexed) {
        mismatches.push({ dims: sorted, cellKey: key, cell: decodeCell(key), indexed, bruteForce });
      }
    }
    return mismatches;
  }
}

export interface CorrectionResult {
  readonly before: Snapshot;
  readonly after: Snapshot;
}

/**
 * 统计库主体。当前快照保存在单个引用中，更正完成后原子替换发布。
 */
export class EventStatsStore {
  #current: Snapshot;

  constructor() {
    this.#current = new Snapshot(0, new Map(), new Map(), new Map());
  }

  /** 当前已发布快照；读取即得一致视图。 */
  getSnapshot(): Snapshot {
    return this.#current;
  }

  /**
   * 一次更正：撤销 eventId 的旧标签贡献，加入新标签贡献，原子发布。
   * labels 为 null 表示删除该事件。
   * 新旧标签完全相同则不产生新版本（before === after）。
   */
  correct(eventId: string, labels: Labels | null): CorrectionResult {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new TypeError("eventId must be a non-empty string");
    }
    const before = this.#current;
    const oldKey = before.eventKey(eventId);
    const normalized = labels === null ? null : normalizeLabels(labels);
    const newKey = normalized === null ? null : comboKeyOf(normalized);

    if (oldKey === newKey) {
      return { before, after: before };
    }

    // 写时复制：全部修改在私有副本上进行。
    const events = new Map(before.snapshotEvents());
    const combos = new Map(before.snapshotCombos());
    const counts = new Map(before.comboCounts());

    if (oldKey !== undefined) {
      events.delete(eventId);
      const remaining = counts.get(oldKey)! - 1;
      if (remaining === 0) {
        counts.delete(oldKey);
        combos.delete(oldKey);
      } else {
        counts.set(oldKey, remaining);
      }
    }
    if (newKey !== null) {
      events.set(eventId, newKey);
      if (!combos.has(newKey)) combos.set(newKey, normalized!);
      counts.set(newKey, (counts.get(newKey) ?? 0) + 1);
    }

    const after = new Snapshot(before.version + 1, events, combos, counts);
    this.#current = after; // 原子发布：单次引用替换，读者不会看到中间态。
    return { before, after };
  }
}

/** 两个快照在同一投影下的稀疏差分：只输出计数变化的单元。 */
export function diffProjections(
  before: Snapshot,
  after: Snapshot,
  dims: readonly string[],
): DiffEntry[] {
  const sorted = normalizeDims(dims);
  const a = before.project(sorted);
  const b = after.project(sorted);
  const entries: DiffEntry[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const prev = a.get(key) ?? 0;
    const next = b.get(key) ?? 0;
    if (prev !== next) {
      entries.push({ cellKey: key, cell: decodeCell(key), before: prev, after: next, delta: next - prev });
    }
  }
  return entries;
}
