/**
 * secret-scanner: 有限字节模式 + 上下文白名单的秘密串扫描库。
 *
 * - 模式为有限字节串（非正则），支持任意二进制数据。
 * - 支持整串扫描与任意切块流式扫描，块边界不漏匹配。
 * - 白名单按 [start, end) 字节区间给出，仅遮盖被完整包含的匹配；
 *   部分重叠的匹配仍然上报。
 * - 结果报告原偏移，重叠匹配归并后生成遮盖预览。
 */

/** 左闭右开字节区间 [start, end)。 */
export interface Range {
  start: number;
  end: number;
}

/** 一条有限字节模式。 */
export interface BytePattern {
  name: string;
  bytes: Uint8Array;
}

/** 一次命中，偏移为相对整个输入的原始字节偏移。 */
export interface Match extends Range {
  name: string;
}

export interface ScanOptions {
  /** 上下文白名单区间（字节偏移，左闭右开）。 */
  whitelist?: Range[];
  /** 遮盖字符，默认 "*"。多字节字符会按字节循环填充。 */
  maskChar?: string;
}

export interface ScanResult {
  /** 未被白名单遮盖的命中，按 (start, end, name) 排序。 */
  matches: Match[];
  /** 被白名单完整包含而遮盖的命中。 */
  suppressed: Match[];
  /** matches 的重叠区间归并结果，用于遮盖。 */
  maskedRanges: Range[];
  /** 遮盖预览：命中区间字节被 maskChar 替换，其余原样解码。 */
  preview: string;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** 便捷构造：由字符串（UTF-8 编码）生成模式。 */
export function pattern(name: string, text: string): BytePattern {
  return { name, bytes: new TextEncoder().encode(text) };
}

/** 在 haystack 中查找全部模式出现位置（含相互重叠的出现），偏移相对 haystack 起点。 */
export function findAll(haystack: Uint8Array, patterns: BytePattern[]): Match[] {
  const out: Match[] = [];
  for (const p of patterns) {
    const needle = p.bytes;
    if (needle.length === 0 || needle.length > haystack.length) continue;
    const first = needle[0]!;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      if (haystack[i] !== first) continue;
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ name: p.name, start: i, end: i + needle.length });
    }
  }
  out.sort(compareMatch);
  return out;
}

function compareMatch(a: Match, b: Match): number {
  return a.start - b.start || a.end - b.end || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** 归并重叠或首尾相接的区间，输入无需有序。 */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/** 命中被某个白名单区间完整包含时才视为被遮盖（mergedWhitelist 须已归并排序）。 */
export function isWhitelisted(m: Range, mergedWhitelist: Range[]): boolean {
  for (const w of mergedWhitelist) {
    if (w.start > m.start) break;
    if (w.start <= m.start && m.end <= w.end) return true;
  }
  return false;
}

/** 生成遮盖预览：mergedRanges 内字节替换为 maskChar，其余按 UTF-8 解码。 */
export function maskPreview(data: Uint8Array | string, mergedRanges: Range[], maskChar = "*"): string {
  const bytes = toBytes(data).slice();
  const encoded = new TextEncoder().encode(maskChar);
  const fill = encoded.length > 0 ? encoded : new Uint8Array([0x2a]);
  for (const r of mergedRanges) {
    for (let i = Math.max(0, r.start); i < Math.min(bytes.length, r.end); i++) {
      bytes[i] = fill[i % fill.length]!;
    }
  }
  return new TextDecoder().decode(bytes);
}

function summarize(bytes: Uint8Array, matches: Match[], whitelist: Range[], maskChar: string): ScanResult {
  const mergedWhitelist = mergeRanges(whitelist);
  const kept: Match[] = [];
  const suppressed: Match[] = [];
  for (const m of matches) {
    (isWhitelisted(m, mergedWhitelist) ? suppressed : kept).push(m);
  }
  const maskedRanges = mergeRanges(kept);
  return { matches: kept, suppressed, maskedRanges, preview: maskPreview(bytes, maskedRanges, maskChar) };
}

/** 整串扫描。 */
export function scan(data: Uint8Array | string, patterns: BytePattern[], opts: ScanOptions = {}): ScanResult {
  const bytes = toBytes(data);
  return summarize(bytes, findAll(bytes, patterns), opts.whitelist ?? [], opts.maskChar ?? "*");
}

/**
 * 流式切块扫描器。任意切块（含空块、单字节块）与整串扫描结果一致：
 * 每次 push 保留 maxPatternLen-1 字节尾部，跨块边界的匹配不会遗漏；
 * 通过上报下界 floor 去重，同一命中只报告一次，偏移始终为原偏移。
 * 为输出遮盖预览，扫描器保留输入字节副本；只需命中报告时可忽略 preview。
 */
export class ChunkScanner {
  private readonly patterns: BytePattern[];
  private readonly whitelist: Range[];
  private readonly maskChar: string;
  private readonly maxLen: number;
  private readonly received: Uint8Array[] = [];
  private pending = new Uint8Array(0);
  private base = 0;
  private floor = 0;
  private collected: Match[] = [];

  constructor(patterns: BytePattern[], opts: ScanOptions = {}) {
    this.patterns = patterns.filter((p) => p.bytes.length > 0);
    this.whitelist = opts.whitelist ?? [];
    this.maskChar = opts.maskChar ?? "*";
    this.maxLen = this.patterns.reduce((n, p) => Math.max(n, p.bytes.length), 0);
  }

  push(chunk: Uint8Array | string): void {
    const part = toBytes(chunk);
    this.received.push(part.slice());
    const buf = new Uint8Array(this.pending.length + part.length);
    buf.set(this.pending, 0);
    buf.set(part, this.pending.length);

    const keep = Math.min(this.maxLen - 1, buf.length);
    const newFloor = this.base + buf.length - keep;
    for (const m of findAll(buf, this.patterns)) {
      const absStart = this.base + m.start;
      if (absStart >= this.floor && absStart < newFloor) {
        this.collected.push({ name: m.name, start: absStart, end: absStart + (m.end - m.start) });
      }
    }
    this.pending = buf.slice(buf.length - keep);
    this.base = newFloor;
    this.floor = newFloor;
  }

  /** 收尾：上报残留尾部中的命中并汇总结果。 */
  end(): ScanResult {
    for (const m of findAll(this.pending, this.patterns)) {
      const absStart = this.base + m.start;
      if (absStart >= this.floor) {
        this.collected.push({ name: m.name, start: absStart, end: absStart + (m.end - m.start) });
      }
    }
    this.collected.sort(compareMatch);
    return summarize(this.allBytes(), this.collected, this.whitelist, this.maskChar);
  }

  private allBytes(): Uint8Array {
    const size = this.received.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of this.received) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}
