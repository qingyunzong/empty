import { type Category, type ExecutionEvent } from './events.js';
/** 诊断结果。 */
export interface Diagnosis {
    /** 终止类别；无执行证据时为 'unknown'。 */
    readonly category: Category;
    /** 被判定为直接致终止的事件 id；unknown 时为 null。 */
    readonly terminalEventId: string | null;
    /**
     * 完整因果链：从根原因到终止事件，按因果序排列
     * （原因先于结果，终止事件为最后一个元素）。
     */
    readonly causalChain: readonly ExecutionEvent[];
    /** 因果链中引用了但日志里缺失的事件 id。 */
    readonly missingCauseIds: readonly string[];
    /** 判定依据说明。 */
    readonly reason: string;
}
/**
 * 诊断一次运行的结构化事件流。
 *
 * 规则：
 * - 没有任何具备终止证据的事件 -> unknown（没有执行证据）。
 * - 存在多个终止候选时，按最早直接致终止事件定类。
 * - 类别由有限表 TERMINATION_TABLE 按 kind 查得，不解析文本。
 */
export declare function diagnose(events: readonly ExecutionEvent[]): Diagnosis;
