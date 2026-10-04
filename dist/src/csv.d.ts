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
export declare class CsvParser {
    private readonly emit;
    private state;
    private offset;
    private fieldStart;
    private fieldQuoted;
    private rawChunks;
    private fields;
    private skipLF;
    constructor(emit: (record: CsvRecord) => void);
    /** 送入一个任意大小的字节块（可切在任意位置，包括引号、\r\n、多字节字符中间） */
    push(chunk: Uint8Array): void;
    /** 流结束：冲刷末尾未以换行符结尾的记录 */
    end(): void;
    /** 处理一个字节的状态迁移（结构字节不计入字段原始区间，由 push 负责切片） */
    private step;
    private endField;
    private endRecord;
}
/** 便捷入口：解析完整缓冲或任意切块序列，返回全部记录 */
export declare function parseCsv(input: Uint8Array | Iterable<Uint8Array>): CsvRecord[];
