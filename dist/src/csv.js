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
const COMMA = 0x2c; // ,
const QUOTE = 0x22; // "
const LF = 0x0a; // \n
const CR = 0x0d; // \r
export class CsvParser {
    emit;
    state = 0 /* State.FieldStart */;
    offset = 0; // 下一个待处理字节的绝对偏移
    fieldStart = 0; // 当前字段起点（绝对偏移）
    fieldQuoted = false;
    rawChunks = []; // 当前字段的原始字节片段
    fields = [];
    skipLF = false; // 上一字节为 \r，等待可能的 \n
    constructor(emit) {
        this.emit = emit;
    }
    /** 送入一个任意大小的字节块（可切在任意位置，包括引号、\r\n、多字节字符中间） */
    push(chunk) {
        let segStart = 0;
        for (let k = 0; k < chunk.length; k++) {
            const i = this.offset++;
            const b = chunk[k];
            if (this.skipLF) {
                this.skipLF = false;
                if (b === LF) {
                    if (k > segStart)
                        this.rawChunks.push(chunk.subarray(segStart, k));
                    segStart = k + 1;
                    this.fieldStart = i + 1;
                    continue;
                }
            }
            // 结构字节（分隔符/换行符）不属于字段原始区间；引号字段内无结构字节。
            // 必须在 step() 触发 endField 之前先冲刷前序片段。
            if ((b === COMMA || b === LF || b === CR) &&
                this.state !== 2 /* State.Quoted */) {
                if (k > segStart)
                    this.rawChunks.push(chunk.subarray(segStart, k));
                segStart = k + 1;
            }
            this.step(b, i);
        }
        if (chunk.length > segStart)
            this.rawChunks.push(chunk.subarray(segStart, chunk.length));
    }
    /** 流结束：冲刷末尾未以换行符结尾的记录 */
    end() {
        const i = this.offset;
        switch (this.state) {
            case 0 /* State.FieldStart */:
                // 形如 "a," 的末尾：补一个空字段
                if (this.fields.length > 0) {
                    this.endField(i);
                    this.endRecord(i);
                }
                break;
            case 1 /* State.Unquoted */:
            case 4 /* State.AfterQuoted */:
            case 2 /* State.Quoted */: // 未闭合引号：按 EOF 容错收尾
            case 3 /* State.QuoteInQuoted */:
                this.endField(i);
                this.endRecord(i);
                break;
        }
    }
    /** 处理一个字节的状态迁移（结构字节不计入字段原始区间，由 push 负责切片） */
    step(b, i) {
        switch (this.state) {
            case 0 /* State.FieldStart */:
                if (b === COMMA) {
                    this.endField(i);
                    this.fieldStart = i + 1;
                    return;
                }
                if (b === QUOTE) {
                    this.fieldQuoted = true;
                    this.state = 2 /* State.Quoted */;
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
                this.state = 1 /* State.Unquoted */;
                return;
            case 1 /* State.Unquoted */:
                if (b === COMMA) {
                    this.endField(i);
                    this.state = 0 /* State.FieldStart */;
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
            case 2 /* State.Quoted */:
                if (b === QUOTE)
                    this.state = 3 /* State.QuoteInQuoted */;
                return;
            case 3 /* State.QuoteInQuoted */:
                if (b === QUOTE) {
                    this.state = 2 /* State.Quoted */; // 转义 ""
                    return;
                }
                if (b === COMMA) {
                    this.endField(i);
                    this.state = 0 /* State.FieldStart */;
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
                this.state = 4 /* State.AfterQuoted */; // 闭引号后的尾随垃圾，仍属本字段
                return;
            case 4 /* State.AfterQuoted */:
                if (b === COMMA) {
                    this.endField(i);
                    this.state = 0 /* State.FieldStart */;
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
    endField(end) {
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
    endRecord(end) {
        this.emit({ fields: this.fields, start: this.fields[0].start, end });
        this.fields = [];
        this.state = 0 /* State.FieldStart */;
    }
}
/** 由原始字节解码字段值；引号字段去引号并还原 "" 转义，闭引号后的垃圾原样保留 */
function decodeValue(raw, quoted) {
    if (!quoted)
        return raw.toString("utf8");
    const out = [];
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
export function parseCsv(input) {
    const records = [];
    const parser = new CsvParser((r) => records.push(r));
    if (input instanceof Uint8Array) {
        parser.push(input);
    }
    else {
        for (const chunk of input)
            parser.push(chunk);
    }
    parser.end();
    return records;
}
