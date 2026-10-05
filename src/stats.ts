/**
 * tag-stats：按事件 ID 维护多维标签组合计数的统计库。
 *
 * - 每个事件 ID 对应一份标签集合（维度名 -> 字符串值）。
 * - 空字符串标签 "" 是合法取值，与“缺失该维度”严格区分。
 * - correct() 一次完成“撤旧 + 加新”，先校验后变更，原子发布。
 * - query() 支持 0..MAX_PROJECTION_DIMS 维的任意投影聚合。
 * - 变更操作返回稀疏差分：只含计数发生变化的组合，归零组合被移除。
 * - verify() 用全部事件逐条投影重新折叠，与在线聚合结果交叉核对。
 */

export type TagSet = Readonly<Record<string, string>>;

export interface ComboCount {
  readonly tags: TagSet;
  readonly count: number;
}

export interface DiffEntry {
  /** 受影响的全维度标签组合。 */
  readonly tags: TagSet;
  readonly before: number;
  readonly after: number;
  /** after - before，非零。 */
  readonly delta: number;
}

export interface VerifyMismatch {
  /** 规范化的组合键（JSON 编码的 [维度, 值] 有序对）。 */
  readonly key: string;
  /** 由全部事件逐条投影折叠出的期望值。 */
  readonly expected: number;
  /** 在线聚合侧的实际值。 */
  readonly actual: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checkedEvents: number;
  readonly checkedCombos: number;
  readonly mismatches: readonly VerifyMismatch[];
}

export const MAX_PROJECTION_DIMS = 4;

/** 规范化组合键：按维度名排序的 [维度, 值] 对做 JSON 编码。缺失维度不出现，空值编码为 ""。 */
function comboKey(tags: TagSet): string {
  const dims = Object.keys(tags).sort();
  const pairs: string[][] = new Array(dims.length);
  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i] as string;
    pairs[i] = [dim, tags[dim] as string];
  }
  return JSON.stringify(pairs);
}

function normalizeTags(eventId: string, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`事件 ${eventId} 的标签必须是对象`);
  }
  const out: Record<string, string> = {};
  for (const [dim, value] of Object.entries(input)) {
    if (dim.length === 0) {
      throw new TypeError(`事件 ${eventId} 含有空维度名`);
    }
    if (typeof value !== "string") {
      throw new TypeError(
        `事件 ${eventId} 维度 ${dim} 的值必须是字符串（缺失请省略该键，空标签用 ""）`,
      );
    }
    out[dim] = value;
  }
  return out;
}

function requireEventId(eventId: unknown): string {
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("事件 ID 必须是非空字符串");
  }
  return eventId;
}

function validateProjection(dimensions: readonly string[]): readonly string[] {
  if (!Array.isArray(dimensions)) {
    throw new TypeError("投影维度必须是字符串数组");
  }
  if (dimensions.length > MAX_PROJECTION_DIMS) {
    throw new RangeError(
      `投影最多 ${MAX_PROJECTION_DIMS} 维，收到 ${dimensions.length} 维`,
    );
  }
  const seen = new Set<string>();
  for (const dim of dimensions) {
    if (typeof dim !== "string" || dim.length === 0) {
      throw new TypeError("投影维度必须是非空字符串");
    }
    if (seen.has(dim)) {
      throw new TypeError(`投影维度重复: ${dim}`);
    }
    seen.add(dim);
  }
  return dimensions;
}

function projectTags(tags: TagSet, dimensions: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dim of dimensions) {
    if (Object.prototype.hasOwnProperty.call(tags, dim)) {
      out[dim] = tags[dim] as string;
    }
  }
  return out;
}

export class TagStats {
  /** 事件 ID -> 标签集合（规范化副本）。 */
  private readonly events = new Map<string, Record<string, string>>();
  /** 全维度组合键 -> 计数（稀疏：归零即删除）。 */
  private readonly counts = new Map<string, number>();
  /** 全维度组合键 -> 标签集合，用于解码与投影。 */
  private readonly combos = new Map<string, Record<string, string>>();

  get eventCount(): number {
    return this.events.size;
  }

  get comboCount(): number {
    return this.counts.size;
  }

  has(eventId: string): boolean {
    return this.events.has(eventId);
  }

  tagsOf(eventId: string): TagSet | undefined {
    const tags = this.events.get(eventId);
    return tags === undefined ? undefined : { ...tags };
  }

  /** 发布新事件，计数 +1。返回稀疏差分。 */
  publish(eventId: string, tags: TagSet): DiffEntry[] {
    const id = requireEventId(eventId);
    if (this.events.has(id)) {
      throw new Error(`事件 ${id} 已存在，请使用 correct() 更正`);
    }
    const normalized = normalizeTags(id, tags);
    // 校验全部通过后才变更，保证原子发布。
    this.events.set(id, normalized);
    const acc = new Map<string, DiffEntry>();
    this.applyDelta(comboKey(normalized), normalized, +1, acc);
    return finalizeDiff(acc);
  }

  /**
   * 更正事件：撤旧组合（-1）加新组合（+1），一次原子发布。
   * 新旧组合相同则为无操作，返回空差分。
   */
  correct(eventId: string, newTags: TagSet): DiffEntry[] {
    const id = requireEventId(eventId);
    const oldTags = this.events.get(id);
    if (oldTags === undefined) {
      throw new Error(`事件 ${id} 不存在，无法更正`);
    }
    const normalized = normalizeTags(id, newTags);
    const oldKey = comboKey(oldTags);
    const newKey = comboKey(normalized);
    if (oldKey === newKey) {
      return [];
    }
    // 校验全部通过后才变更：撤旧与加新在同一同步区间内生效。
    const acc = new Map<string, DiffEntry>();
    this.applyDelta(oldKey, oldTags, -1, acc);
    this.applyDelta(newKey, normalized, +1, acc);
    this.events.set(id, normalized);
    return finalizeDiff(acc);
  }

  /** 撤回事件，计数 -1。返回稀疏差分。 */
  retract(eventId: string): DiffEntry[] {
    const id = requireEventId(eventId);
    const oldTags = this.events.get(id);
    if (oldTags === undefined) {
      throw new Error(`事件 ${id} 不存在，无法撤回`);
    }
    this.events.delete(id);
    const acc = new Map<string, DiffEntry>();
    this.applyDelta(comboKey(oldTags), oldTags, -1, acc);
    return finalizeDiff(acc);
  }

  /**
   * 任意投影查询：按给定维度子集（0..4 维）聚合全部组合计数。
   * 空数组返回总计数。结果按规范化键排序，确定可重放。
   */
  query(dimensions: readonly string[]): ComboCount[] {
    const dims = validateProjection(dimensions);
    const folded = new Map<string, number>();
    const decoded = new Map<string, TagSet>();
    for (const [key, count] of this.counts) {
      const tags = this.combos.get(key) as Record<string, string>;
      const projected = projectTags(tags, dims);
      const pKey = comboKey(projected);
      folded.set(pKey, (folded.get(pKey) ?? 0) + count);
      if (!decoded.has(pKey)) decoded.set(pKey, projected);
    }
    return [...folded.keys()].sort().map((pKey) => ({
      tags: { ...(decoded.get(pKey) as TagSet) },
      count: folded.get(pKey) as number,
    }));
  }

  /**
   * 交叉核对：用全部事件逐条投影重新折叠，与在线聚合结果比较。
   * 省略 dimensions 时核对全维度组合计数；否则核对指定投影。
   */
  verify(dimensions?: readonly string[]): VerifyResult {
    const dims = dimensions === undefined ? undefined : validateProjection(dimensions);
    // 期望侧：从事件存储逐条投影折叠。
    const expected = new Map<string, number>();
    for (const tags of this.events.values()) {
      const key = comboKey(dims === undefined ? tags : projectTags(tags, dims));
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    // 实际侧：在线维护的组合计数（需要时做投影）。
    const actual = new Map<string, number>();
    for (const [key, count] of this.counts) {
      const tags = this.combos.get(key) as Record<string, string>;
      const aKey = dims === undefined ? key : comboKey(projectTags(tags, dims));
      actual.set(aKey, (actual.get(aKey) ?? 0) + count);
    }
    const mismatches: VerifyMismatch[] = [];
    for (const [key, expectedCount] of expected) {
      const actualCount = actual.get(key) ?? 0;
      if (actualCount !== expectedCount) {
        mismatches.push({ key, expected: expectedCount, actual: actualCount });
      }
    }
    for (const [key, actualCount] of actual) {
      if (!expected.has(key)) {
        mismatches.push({ key, expected: 0, actual: actualCount });
      }
    }
    mismatches.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      ok: mismatches.length === 0,
      checkedEvents: this.events.size,
      checkedCombos: actual.size,
      mismatches,
    };
  }

  private applyDelta(
    key: string,
    tags: Record<string, string>,
    delta: 1 | -1,
    acc: Map<string, DiffEntry>,
  ): void {
    const before = this.counts.get(key) ?? 0;
    const after = before + delta;
    if (after < 0) {
      throw new Error(`内部错误：组合 ${key} 计数变为负数`);
    }
    if (after === 0) {
      this.counts.delete(key);
      this.combos.delete(key);
    } else {
      this.counts.set(key, after);
      this.combos.set(key, tags);
    }
    const entry = acc.get(key);
    if (entry === undefined) {
      acc.set(key, { tags: { ...tags }, before, after, delta });
    } else {
      acc.set(key, {
        tags: entry.tags,
        before: entry.before,
        after,
        delta: (entry.delta + delta) as number,
      });
    }
  }
}

/** 稀疏化：丢弃净变化为 0 的条目，按键排序保证输出确定。 */
function finalizeDiff(acc: Map<string, DiffEntry>): DiffEntry[] {
  const entries = [...acc.entries()]
    .filter(([, entry]) => entry.delta !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry);
  return entries;
}
