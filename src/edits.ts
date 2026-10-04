/**
 * 半开区间编辑库：对同一原文应用一组 [start, end) 替换，
 * 并提供原文 <-> 新文的双向位置映射。
 */

export type Affinity = 'left' | 'right';

export interface Edit {
  /** 起始位置（含），0 基 */
  readonly start: number;
  /** 结束位置（不含） */
  readonly end: number;
  /** 替换文本；start === end 时为纯插入，text === '' 时为纯删除 */
  readonly text: string;
}

export interface EditResult {
  /** 应用全部编辑后的新文本 */
  readonly text: string;
  /** 原文位置 -> 新文位置 */
  mapForward(pos: number, affinity?: Affinity): number;
  /** 新文位置 -> 原文位置 */
  mapBackward(pos: number, affinity?: Affinity): number;
}

interface Segment {
  readonly origStart: number;
  readonly origEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
  /** true 表示该段来自一次编辑（替换/插入/删除），false 表示未改动区间 */
  readonly replaced: boolean;
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

/**
 * 应用一组基于同一原文的半开区间替换。
 *
 * 规则：
 * - 区间必须满足 0 <= start <= end <= original.length；
 * - 非空区间相互重叠（含插入点严格落在被替换区间内部）时抛出 RangeError；
 * - 同一点插入（start === end 相同）按请求顺序依次生效；
 * - 相邻区间（prev.end === next.start）合法。
 */
export function applyEdits(original: string, edits: readonly Edit[]): EditResult {
  const len = original.length;
  edits.forEach((e, i) => {
    if (!isInt(e.start) || !isInt(e.end) || e.start < 0 || e.start > e.end || e.end > len) {
      throw new RangeError(
        `edit[${i}] 非法区间 [${e.start}, ${e.end})，原文长度 ${len}`,
      );
    }
  });

  // 按 (start, end, 请求序) 稳定排序；同点插入保持请求顺序。
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i)
    .map(({ e }) => e);

  // 重叠检测：下一个区间的 start 严格小于上一个区间的 end 即重叠。
  // 零长区间（插入）end === start，故同点插入互不冲突；
  // 插入点严格落在非零区间内部时 start < prev.end 成立，会被拒绝。
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    const cur = sorted[k];
    if (cur.start < prev.end) {
      throw new RangeError(
        `区间重叠：[${prev.start}, ${prev.end}) 与 [${cur.start}, ${cur.end})`,
      );
    }
  }

  // 构造段序列：未改动段与替换段交替。
  const segments: Segment[] = [];
  let cursor = 0;
  let newCursor = 0;
  let out = '';
  for (const e of sorted) {
    if (e.start > cursor) {
      const gap = original.slice(cursor, e.start);
      segments.push({
        origStart: cursor,
        origEnd: e.start,
        newStart: newCursor,
        newEnd: newCursor + gap.length,
        replaced: false,
      });
      out += gap;
      newCursor += gap.length;
    }
    segments.push({
      origStart: e.start,
      origEnd: e.end,
      newStart: newCursor,
      newEnd: newCursor + e.text.length,
      replaced: true,
    });
    out += e.text;
    newCursor += e.text.length;
    cursor = e.end;
  }
  if (cursor < len) {
    const gap = original.slice(cursor);
    segments.push({
      origStart: cursor,
      origEnd: len,
      newStart: newCursor,
      newEnd: newCursor + gap.length,
      replaced: false,
    });
    out += gap;
  }
  const text = out;

  function checkPos(pos: number, max: number, name: string): void {
    if (!isInt(pos) || pos < 0 || pos > max) {
      throw new RangeError(`${name} 位置 ${pos} 越界 [0, ${max}]`);
    }
  }

  function mapForward(pos: number, affinity: Affinity = 'left'): number {
    checkPos(pos, len, '原文');
    for (const s of segments) {
      if (pos < s.origStart) break;
      if (!s.replaced) {
        // 未改动段：左亲和时右端点归本段；右亲和时让位给后续段，
        // 以便同点插入能把位置映到插入文本之后（无插入时值相同）
        if (pos < s.origEnd || (pos === s.origEnd && affinity === 'left')) {
          return s.newStart + (pos - s.origStart);
        }
      } else if (s.origStart === s.origEnd) {
        // 纯插入点：左亲和落在插入文本之前，右亲和落在之后
        // 同点连续插入时右亲和需越过全部插入段，故不立即返回，
        // 由后续段（下一个插入段、未改动段或文末兜底）给出位置
        if (pos === s.origStart && affinity === 'left') return s.newStart;
      } else {
        // 被替换区间：内部按亲和绑定到替换文本的边缘；
        // 左边界归前一段（== newStart），右边界归后一段（== newEnd）
        if (pos === s.origStart) return s.newStart;
        if (pos < s.origEnd) return affinity === 'left' ? s.newStart : s.newEnd;
      }
    }
    return text.length; // pos === len 且末尾无未改动段
  }

  function mapBackward(pos: number, affinity: Affinity = 'left'): number {
    checkPos(pos, text.length, '新文');
    for (const s of segments) {
      if (pos < s.newStart) break;
      if (!s.replaced) {
        if (pos <= s.newEnd) return s.origStart + (pos - s.newStart);
      } else if (s.newStart === s.newEnd) {
        // 纯删除产生的零长新文段：两个亲和都坍缩到同一点，跳过即可
        continue;
      } else {
        // 替换文本内部：按亲和绑定到原区间边缘
        if (pos === s.newStart) return s.origStart;
        if (pos < s.newEnd) return affinity === 'left' ? s.origStart : s.origEnd;
      }
    }
    return len; // pos === text.length 且末尾无未改动段
  }

  return { text, mapForward, mapBackward };
}
