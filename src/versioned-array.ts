/**
 * VersionedArray — 可持久化查询的可变整数数组。
 *
 * 语义：
 * - 数组通过块更新（block update）演化，每次成功的块更新产生一个不可变新版本；
 *   旧版本永久保留，可随时查询。
 * - 块更新是原子的：块内所有替换先整体校验，任一非法则整个块被拒绝，
 *   不产生新版本，已有版本不受任何影响。
 * - 范围众数：频次最高者胜出；频次并列时取数值较小者。空范围（from > to）
 *   返回 null。
 */

export interface Replacement {
  readonly index: number;
  readonly value: number;
}

export interface ModeEvidence {
  /** 众数值 */
  readonly value: number;
  /** 众数在范围内的出现次数 */
  readonly frequency: number;
  /** 证据：众数在数组中的全部下标（升序），均落在 [from, to] 内 */
  readonly positions: readonly number[];
  /** 被查询的闭区间 */
  readonly from: number;
  readonly to: number;
  /** 被查询的版本号 */
  readonly versionId: number;
}

export interface VersionView {
  readonly id: number;
  readonly length: number;
  at(index: number): number;
  toArray(): readonly number[];
}

function assertSafeInteger(n: number, what: string): void {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new TypeError(`${what} must be a safe integer, got ${String(n)}`);
  }
}

export class VersionedArray {
  private readonly snapshots: ReadonlyArray<number>[] = [];

  constructor(initial: readonly number[]) {
    if (initial.length === 0) {
      throw new RangeError("initial array must not be empty");
    }
    initial.forEach((v, i) => assertSafeInteger(v, `initial[${i}]`));
    this.snapshots.push(Object.freeze(initial.slice()));
  }

  /** 当前版本总数（初始版本号为 0）。 */
  get versionCount(): number {
    return this.snapshots.length;
  }

  get length(): number {
    return this.snapshots[0]!.length;
  }

  /** 最新版本号。 */
  get latestId(): number {
    return this.snapshots.length - 1;
  }

  /** 获取任意历史版本（含最新）的只读视图。 */
  version(id: number): VersionView {
    const snap = this.snapshot(id);
    return {
      id,
      length: snap.length,
      at(index: number): number {
        assertSafeInteger(index, "index");
        if (index < 0 || index >= snap.length) {
          throw new RangeError(`index ${index} out of bounds [0, ${snap.length})`);
        }
        return snap[index]!;
      },
      toArray(): readonly number[] {
        return snap;
      },
    };
  }

  /**
   * 原子块更新：校验全部替换后才提交。
   * - 空块：无操作，直接返回当前最新版本（不产生新版本）。
   * - 任一替换非法（非整数、下标越界、块内下标重复）→ 抛错，整体不生效。
   */
  applyBlock(replacements: readonly Replacement[]): VersionView {
    if (replacements.length === 0) {
      return this.version(this.latestId);
    }
    // 第一阶段：完整校验，不触碰任何状态。
    const seen = new Set<number>();
    replacements.forEach((r, i) => {
      assertSafeInteger(r.index, `replacements[${i}].index`);
      assertSafeInteger(r.value, `replacements[${i}].value`);
      if (r.index < 0 || r.index >= this.length) {
        throw new RangeError(
          `replacements[${i}].index ${r.index} out of bounds [0, ${this.length})`,
        );
      }
      if (seen.has(r.index)) {
        throw new Error(
          `duplicate index ${r.index} within one block update (atomic reject)`,
        );
      }
      seen.add(r.index);
    });
    // 第二阶段：在副本上应用并提交为新版本。
    const next = this.snapshots[this.latestId]!.slice();
    for (const r of replacements) {
      next[r.index] = r.value;
    }
    this.snapshots.push(Object.freeze(next));
    return this.version(this.latestId);
  }

  /**
   * 范围众数查询（闭区间 [from, to]）。
   * 频次高者优先，并列取数值小者；空范围（from > to）返回 null。
   */
  rangeMode(versionId: number, from: number, to: number): ModeEvidence | null {
    assertSafeInteger(from, "from");
    assertSafeInteger(to, "to");
    if (from > to) {
      return null; // 空范围
    }
    const snap = this.snapshot(versionId);
    if (from < 0 || to >= snap.length) {
      throw new RangeError(
        `range [${from}, ${to}] out of bounds for length ${snap.length}`,
      );
    }

    const counts = new Map<number, { count: number; positions: number[] }>();
    for (let i = from; i <= to; i++) {
      const v = snap[i]!;
      const entry = counts.get(v);
      if (entry) {
        entry.count += 1;
        entry.positions.push(i);
      } else {
        counts.set(v, { count: 1, positions: [i] });
      }
    }

    let bestValue = 0;
    let bestCount = -1;
    let bestPositions: number[] = [];
    for (const [value, entry] of counts) {
      if (
        entry.count > bestCount ||
        (entry.count === bestCount && value < bestValue)
      ) {
        bestValue = value;
        bestCount = entry.count;
        bestPositions = entry.positions;
      }
    }
    return {
      value: bestValue,
      frequency: bestCount,
      positions: Object.freeze(bestPositions.slice()),
      from,
      to,
      versionId,
    };
  }

  private snapshot(id: number): ReadonlyArray<number> {
    assertSafeInteger(id, "versionId");
    const snap = this.snapshots[id];
    if (snap === undefined) {
      throw new RangeError(
        `version ${id} does not exist (have 0..${this.snapshots.length - 1})`,
      );
    }
    return snap;
  }
}
