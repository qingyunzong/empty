/**
 * 按字节块接收的流式 CSV 解析器（仅依赖 Node.js 内置 Buffer）。
 *
 * 语义规则：
 * - 引号字段仅在 `"` 为字段首字节时开启；字段内部 `""` 为转义引号。
 * - 合法引号字段可跨物理行，引号内换行不切分记录。
 * - 非法引号（出现在非字段首位置，或闭引号之后的垃圾区）按字面字节处理，
 *   不会开启引号模式，其影响被隔离到当前物理行尾（换行仍正常结束记录）。
 * - 每个字段保留原始字节区间 [start, end)（含引号，不含分隔符/换行符），
 *   偏移为整个字节流的绝对偏移，与切块方式无关。
 * - 换行符支持 \n、\r\n、\r。
 */

export interface CsvField {
  /** 解码后的字段值（去除成对引号、还原 "" 转义；非法引号原样保留） */
  readonly value: string;
  /** 字段原始字节（含引号与尾随垃圾） */
  readonly raw: Buffer;
  /** 原始区间起点（绝对字节偏移，含开引号） */
  readonly start: number;
  /** 原始区间终点（不含；含闭引号，不含分隔符/换行符） */
  readonly end: number;
  /** 是否以合法开引号起始 */
  readonly quoted: boolean;
}

export interface CsvRecord {
  readonly fields: CsvField[];
  /** 记录起点 = 首个字段起点 */
  readonly start: number;
  /** 记录终点 = 记录终止符（\n / \r / \r\n）首字节偏移；EOF 结尾时为流长度 */
  readonly end: number;
}

const COMMA = 0x2c; // ,
const QUOTE = 0x22; // "
const LF = 0x0a; // \n
const CR = 0x0d; // \r

const enum State {
  FieldStart, // 字段首字节之前
  Unquoted, // 无引号字段内
  Quoted, // 合法引号字段内
  QuoteInQuoted, // 引号字段内刚遇到一个 "（待判定转义或闭合）
  AfterQuoted, // 闭引号之后、分隔符之前的垃圾区
}

export class CsvParser {
  private state = State.FieldStart;
  private offset = 0; // 下一个待处理字节的绝对偏移
  private fieldStart = 0; // 当前字段起点（绝对偏移）
  private fieldQuoted = false;
  private rawChunks: Uint8Array[] = []; // 当前字段的原始字节片段
  private fields: CsvField[] = [];
  private skipLF = false; // 上一字节为 \r，等待可能的 \n

  constructor(private readonly emit: (record: CsvRecord) => void) {}

  /** 送入一个任意大小的字节块（可切在任意位置，包括引号、\r\n、多字节字符中间） */
  push(chunk: Uint8Array): void {
    let segStart = 0;
    for (let k = 0; k < chunk.length; k++) {
      const i = this.offset++;
      const b = chunk[k];
      if (this.skipLF) {
        this.skipLF = false;
        if (b === LF) {
          if (k > segStart) this.rawChunks.push(chunk.subarray(segStart, k));
          segStart = k + 1;
          this.fieldStart = i + 1;
          continue;
        }
      }
      // 结构字节（分隔符/换行符）不属于字段原始区间；引号字段内无结构字节。
      // 必须在 step() 触发 endField 之前先冲刷前序片段。
      if (
        (b === COMMA || b === LF || b === CR) &&
        this.state !== State.Quoted
      ) {
        if (k > segStart) this.rawChunks.push(chunk.subarray(segStart, k));
        segStart = k + 1;
      }
      this.step(b, i);
    }
    if (chunk.length > segStart) this.rawChunks.push(chunk.subarray(segStart, chunk.length));
  }

  /** 流结束：冲刷末尾未以换行符结尾的记录 */
  end(): void {
    const i = this.offset;
    switch (this.state) {
      case State.FieldStart:
        // 形如 "a," 的末尾：补一个空字段
        if (this.fields.length > 0) {
          this.endField(i);
          this.endRecord(i);
        }
        break;
      case State.Unquoted:
      case State.AfterQuoted:
      case State.Quoted: // 未闭合引号：按 EOF 容错收尾
      case State.QuoteInQuoted: // 末尾的 " 视为闭引号
        this.endField(i);
        this.endRecord(i);
        break;
    }
  }

  /** 处理一个字节的状态迁移（结构字节不计入字段原始区间，由 push 负责切片） */
  private step(b: number, i: number): void {
    switch (this.state) {
      case State.FieldStart:
        if (b === COMMA) {
          this.endField(i);
          this.fieldStart = i + 1;
          return;
        }
        if (b === QUOTE) {
          this.fieldQuoted = true;
          this.state = State.Quoted;
          return;
        }
        if (b === LF) {
          this.endField(i);
          this.endRecord(i);
          this.fieldStart = i + 1;
          return;
        }
        if (b === CR) {
          this.endField(i);
          this.endRecord(i);
          this.skipLF = true;
          this.fieldStart = i + 1;
          return;
        }
        this.state = State.Unquoted;
        return;

      case State.Unquoted:
        if (b === COMMA) {
          this.endField(i);
          this.state = State.FieldStart;
          this.fieldStart = i + 1;
          return;
        }
        if (b === LF || b === CR) {
          this.endField(i);
          this.endRecord(i);
          this.skipLF = b === CR;
          this.fieldStart = i + 1;
          return;
        }
        // 非法引号：作为字面字节保留，不开启引号模式（隔离到本物理行尾）
        return;

      case State.Quoted:
        if (b === QUOTE) this.state = State.QuoteInQuoted;
        return;

      case State.QuoteInQuoted:
        if (b === QUOTE) {
          this.state = State.Quoted; // 转义 ""
          return;
        }
        if (b === COMMA) {
          this.endField(i);
          this.state = State.FieldStart;
          this.fieldStart = i + 1;
          return;
        }
        if (b === LF || b === CR) {
          this.endField(i);
          this.endRecord(i);
          this.skipLF = b === CR;
          this.fieldStart = i + 1;
          return;
        }
        this.state = State.AfterQuoted; // 闭引号后的尾随垃圾，仍属本字段
        return;

      case State.AfterQuoted:
        if (b === COMMA) {
          this.endField(i);
          this.state = State.FieldStart;
          this.fieldStart = i + 1;
          return;
        }
        if (b === LF || b === CR) {
          this.endField(i);
          this.endRecord(i);
          this.skipLF = b === CR;
          this.fieldStart = i + 1;
          return;
        }
        return;
    }
  }

  private endField(end: number): void {
    const raw = Buffer.concat(this.rawChunks);
    this.rawChunks = [];
    this.fields.push({
      value: decodeValue(raw, this.fieldQuoted),
      raw,
      start: this.fieldStart,
      end,
      quoted: this.fieldQuoted,
    });
    this.fieldQuoted = false;
  }

  private endRecord(end: number): void {
    this.emit({ fields: this.fields, start: this.fields[0].start, end });
    this.fields = [];
    this.state = State.FieldStart;
  }
}

/** 由原始字节解码字段值；引号字段去引号并还原 "" 转义，闭引号后的垃圾原样保留 */
function decodeValue(raw: Buffer, quoted: boolean): string {
  if (!quoted) return raw.toString("utf8");
  const out: number[] = [];
  let k = 1; // 跳过开引号
  let closed = false;
  while (k < raw.length) {
    const b = raw[k];
    if (b === QUOTE) {
      if (k + 1 < raw.length && raw[k + 1] === QUOTE) {
        out.push(QUOTE);
        k += 2;
        continue;
      }
      k += 1;
      closed = true;
      break;
    }
    out.push(b);
    k += 1;
  }
  const head = Buffer.from(out);
  return closed
    ? Buffer.concat([head, raw.subarray(k)]).toString("utf8")
    : head.toString("utf8");
}

/** 便捷入口：解析完整缓冲或任意切块序列，返回全部记录 */
export function parseCsv(input: Uint8Array | Iterable<Uint8Array>): CsvRecord[] {
  const records: CsvRecord[] = [];
  const parser = new CsvParser((r) => records.push(r));
  if (input instanceof Uint8Array) {
    parser.push(input);
  } else {
    for (const chunk of input) parser.push(chunk);
  }
  parser.end();
  return records;
}
