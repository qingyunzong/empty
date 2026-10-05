/**
 * 基于原版本字节区间的三路补丁合并。
 *
 * 模型：每个分支对同一原版本给出一组编辑 Edit{start,end,text}，
 * 语义为“把 original[start:end] 替换为 text”。
 *   - start === end        插入
 *   - text === ""          删除
 *   - 否则                 替换
 *
 * 合并规则：
 *   1. 两边编辑区间不相交（含边界相邻）→ 都可合并；
 *   2. 同点插入 → 都保留，按分支 ID 字典序排列（ID 小者在前）；
 *   3. 区间相交但效果相同 → 应用一次；
 *   4. 区间相交且效果不同 → 冲突，取分支 ID 小的一方，并记录双方；
 *   5. 删除/替换区间包含另一方的修改（含严格内部的插入点）→ 冲突。
 */

export interface Edit {
  /** 起始偏移（含），基于原版本 */
  start: number;
  /** 结束偏移（不含），基于原版本 */
  end: number;
  /** 替换文本 */
  text: string;
}

export interface Branch {
  id: string;
  edits: Edit[];
}

export interface Conflict {
  /** 冲突区间（原版本坐标） */
  start: number;
  end: number;
  /** 分支 ID 较小一方的编辑 */
  lowEdits: Edit[];
  /** 分支 ID 较大一方的编辑 */
  highEdits: Edit[];
  /** 双方各自作用于 original[start:end] 后的结果 */
  lowText: string;
  highText: string;
  /** 采用方（分支 ID 较小者） */
  winner: string;
  resolvedText: string;
}

export type Segment =
  | { kind: "keep"; origStart: number; origEnd: number; mergedStart: number }
  | {
      kind: "replace";
      origStart: number;
      origEnd: number;
      mergedStart: number;
      text: string;
      source: string;
    };

export interface MergeResult {
  text: string;
  conflicts: Conflict[];
  segments: Segment[];
  map: PositionMap;
}

interface AppliedEdit extends Edit {
  source: string;
}

function isInsert(e: Edit): boolean {
  return e.start === e.end;
}

/** 编辑 e 是否与区间 [cs, ce) 发生交互（需要归入同一冲突簇）。 */
function interacts(e: Edit, cs: number, ce: number): boolean {
  if (cs === ce) {
    // 点区间：同点插入，或严格包含该点的编辑
    if (isInsert(e)) return e.start === cs;
    return e.start < cs && e.end > cs;
  }
  if (isInsert(e)) return cs < e.start && e.start < ce;
  return e.start < ce && e.end > cs;
}

/** 校验并排序单个分支的编辑；分支内部不允许重叠。 */
function normalize(edits: Edit[], len: number, branchId: string): Edit[] {
  const sorted = edits.map((e) => ({ ...e }));
  for (const e of sorted) {
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.end < e.start ||
      e.end > len
    ) {
      throw new RangeError(
        `branch ${branchId}: invalid edit [${e.start}, ${e.end}) for length ${len}`,
      );
    }
  }
  sorted.sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end || (cur.start === prev.end && isInsert(prev) && isInsert(cur))) {
      throw new Error(
        `branch ${branchId}: overlapping edits [${prev.start}, ${prev.end}) and [${cur.start}, ${cur.end})`,
      );
    }
  }
  return sorted;
}

/** 把一组互不相交的编辑应用到 original[cs:ce) 上，返回结果文本。 */
function applyToSlice(original: string, edits: Edit[], cs: number, ce: number): string {
  let out = "";
  let cursor = cs;
  for (const e of edits) {
    out += original.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += original.slice(cursor, ce);
  return out;
}

/** 双向位置映射：原版本偏移 <-> 合并结果偏移。 */
export class PositionMap {
  readonly origLength: number;
  readonly mergedLength: number;
  private readonly segs: Segment[];

  constructor(segments: Segment[], origLength: number, mergedLength: number) {
    this.segs = segments;
    this.origLength = origLength;
    this.mergedLength = mergedLength;
  }

  /**
   * 原版本偏移 -> 合并结果偏移。
   * 保留区内线性映射；被替换/删除区间内部映射到替换文本的起点；
   * 区间边界映射到对应边界；原文末尾固定映射到合并结果末尾。
   */
  origToMerged(pos: number): number {
    const p = Math.max(0, Math.min(pos, this.origLength));
    if (p === this.origLength) return this.mergedLength;
    const seg = this.findByOrig(p);
    if (seg === undefined) return this.mergedLength;
    if (seg.kind === "keep") {
      return seg.mergedStart + Math.min(p, seg.origEnd) - seg.origStart;
    }
    if (p <= seg.origStart) return seg.mergedStart;
    if (p >= seg.origEnd) return seg.mergedStart + seg.text.length;
    return seg.mergedStart;
  }

  /**
   * 合并结果偏移 -> 原版本偏移。
   * 保留区内线性映射；插入文本内部映射到该区间在原版本中的起点；
   * 合并结果末尾固定映射到原文末尾。
   */
  mergedToOrig(pos: number): number {
    const p = Math.max(0, Math.min(pos, this.mergedLength));
    if (p === this.mergedLength) return this.origLength;
    const seg = this.findByMerged(p);
    if (seg === undefined) return this.origLength;
    if (seg.kind === "keep") {
      return seg.origStart + Math.min(p, seg.mergedStart + (seg.origEnd - seg.origStart)) - seg.mergedStart;
    }
    if (p <= seg.mergedStart) return seg.origStart;
    if (p >= seg.mergedStart + seg.text.length) return seg.origEnd;
    return seg.origStart;
  }

  private findByOrig(p: number): Segment | undefined {
    let lo = 0;
    let hi = this.segs.length - 1;
    let ans: Segment | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.segs[mid]!;
      if (s.origStart <= p) {
        ans = s;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  private findByMerged(p: number): Segment | undefined {
    let lo = 0;
    let hi = this.segs.length - 1;
    let ans: Segment | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.segs[mid]!;
      if (s.mergedStart <= p) {
        ans = s;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }
}

/**
 * 合并两个分支对 original 的补丁。
 * 分支 ID 决定同点插入顺序与冲突取舍（字典序小者优先），与传参顺序无关。
 */
export function merge(original: string, branchA: Branch, branchB: Branch): MergeResult {
  if (branchA.id === branchB.id) {
    throw new Error("branch ids must differ");
  }
  // low 为分支 ID 较小的一方
  const [low, high] = branchA.id < branchB.id ? [branchA, branchB] : [branchB, branchA];
  const editsLow = normalize(low.edits, original.length, low.id);
  const editsHigh = normalize(high.edits, original.length, high.id);

  const applied: AppliedEdit[] = [];
  const conflicts: Conflict[] = [];

  let i = 0;
  let j = 0;
  while (i < editsLow.length || j < editsHigh.length) {
    // 簇种子：两边剩余编辑中位置最靠前的一个
    let cs: number;
    let ce: number;
    if (
      j >= editsHigh.length ||
      (i < editsLow.length &&
        (editsLow[i]!.start < editsHigh[j]!.start ||
          (editsLow[i]!.start === editsHigh[j]!.start && editsLow[i]!.end <= editsHigh[j]!.end)))
    ) {
      cs = editsLow[i]!.start;
      ce = editsLow[i]!.end;
    } else {
      cs = editsHigh[j]!.start;
      ce = editsHigh[j]!.end;
    }
    // 扩张簇：不断吸收与 [cs, ce) 交互的编辑
    const clusterLow: Edit[] = [];
    const clusterHigh: Edit[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      while (i < editsLow.length && interacts(editsLow[i]!, cs, ce)) {
        const e = editsLow[i]!;
        clusterLow.push(e);
        cs = Math.min(cs, e.start);
        ce = Math.max(ce, e.end);
        i++;
        changed = true;
      }
      while (j < editsHigh.length && interacts(editsHigh[j]!, cs, ce)) {
        const e = editsHigh[j]!;
        clusterHigh.push(e);
        cs = Math.min(cs, e.start);
        ce = Math.max(ce, e.end);
        j++;
        changed = true;
      }
    }

    if (clusterLow.length === 0 || clusterHigh.length === 0) {
      // 单边编辑：直接应用
      for (const e of clusterLow) applied.push({ ...e, source: low.id });
      for (const e of clusterHigh) applied.push({ ...e, source: high.id });
      continue;
    }

    if (cs === ce) {
      // 同点插入：两边都保留，分支 ID 小者在前
      const lowText = clusterLow.map((e) => e.text).join("");
      const highText = clusterHigh.map((e) => e.text).join("");
      // 两边插入内容完全相同则只应用一次
      const text = lowText === highText ? lowText : lowText + highText;
      applied.push({ start: cs, end: ce, text, source: `${low.id}+${high.id}` });
      continue;
    }

    const lowText = applyToSlice(original, clusterLow, cs, ce);
    const highText = applyToSlice(original, clusterHigh, cs, ce);
    if (lowText === highText) {
      // 效果相同：应用一次
      applied.push({ start: cs, end: ce, text: lowText, source: `${low.id}+${high.id}` });
    } else {
      // 冲突：取分支 ID 较小一方
      conflicts.push({
        start: cs,
        end: ce,
        lowEdits: clusterLow,
        highEdits: clusterHigh,
        lowText,
        highText,
        winner: low.id,
        resolvedText: lowText,
      });
      applied.push({ start: cs, end: ce, text: lowText, source: low.id });
    }
  }

  // 生成合并文本与分段（位置映射的数据基础）
  applied.sort((x, y) => x.start - y.start || x.end - y.end);
  const segments: Segment[] = [];
  let text = "";
  let cursor = 0;
  for (const e of applied) {
    if (e.start > cursor) {
      segments.push({ kind: "keep", origStart: cursor, origEnd: e.start, mergedStart: text.length });
      text += original.slice(cursor, e.start);
    }
    segments.push({
      kind: "replace",
      origStart: e.start,
      origEnd: e.end,
      mergedStart: text.length,
      text: e.text,
      source: e.source,
    });
    text += e.text;
    cursor = e.end;
  }
  if (cursor < original.length) {
    segments.push({ kind: "keep", origStart: cursor, origEnd: original.length, mergedStart: text.length });
    text += original.slice(cursor);
  }

  return {
    text,
    conflicts,
    segments,
    map: new PositionMap(segments, original.length, text.length),
  };
}
