/**
 * 结构化执行事件模型与有限分类表。
 *
 * 设计约束：
 * - 分类只依据结构化字段（kind / terminatesRun / causeIds），
 *   绝不解析 summary 等自由文本（不从文字猜身份）。
 * - 事件种类是有限枚举，分类表对每个种类都有显式条目，可穷举核对。
 */
/** 诊断分类。 */
export declare const TERMINATION_CATEGORIES: readonly ['prerequisite_missing', 'communication_interrupted', 'assertion_failed'];
export type TerminationCategory = (typeof TERMINATION_CATEGORIES)[number];
/** 诊断结果分类：三种终止类别，或无执行证据时的 unknown。 */
export type Category = TerminationCategory | 'unknown';
/** 全部受支持的事件种类（有限集）。 */
export declare const EVENT_KINDS: readonly ['run_started', 'step_started', 'step_completed', 'prerequisite_missing', 'communication_lost', 'assertion_failed'];
export type EventKind = (typeof EVENT_KINDS)[number];
/**
 * 有限分类表：事件种类 -> 终止类别。
 * null 表示该种类不构成直接终止事件。
 * 表对 EventKind 全量覆盖（Record 强制），测试逐条穷举核对。
 */
export declare const TERMINATION_TABLE: Readonly<Record<EventKind, TerminationCategory | null>>;
/** 结构化执行事件。 */
export interface ExecutionEvent {
    /** 事件唯一标识。 */
    readonly id: string;
    /** 结构化事件种类（分类的唯一依据）。 */
    readonly kind: EventKind;
    /** 时间戳或逻辑时钟，用于“最早”判定。 */
    readonly at: number;
    /** 直接原因事件 id 列表，用于回溯因果链。 */
    readonly causeIds?: readonly string[];
    /**
     * 执行证据：该事件被观测为直接终止了本次运行。
     * 仅当为 true 且 kind 在 TERMINATION_TABLE 中映射到类别时，
     * 才作为终止候选事件。
     */
    readonly terminatesRun?: boolean;
    /** 自由文本备注，仅展示用，绝不参与分类。 */
    readonly summary?: string;
}
