/**
 * 结构化执行事件模型与有限分类表。
 *
 * 设计约束：
 * - 分类只依据结构化字段（kind / terminatesRun / causeIds），
 *   绝不解析 summary 等自由文本（不从文字猜身份）。
 * - 事件种类是有限枚举，分类表对每个种类都有显式条目，可穷举核对。
 */
/** 诊断分类。 */
export const TERMINATION_CATEGORIES = [
    'prerequisite_missing',
    'communication_interrupted',
    'assertion_failed',
];
/** 全部受支持的事件种类（有限集）。 */
export const EVENT_KINDS = [
    'run_started',
    'step_started',
    'step_completed',
    'prerequisite_missing',
    'communication_lost',
    'assertion_failed',
];
/**
 * 有限分类表：事件种类 -> 终止类别。
 * null 表示该种类不构成直接终止事件。
 * 表对 EventKind 全量覆盖（Record 强制），测试逐条穷举核对。
 */
export const TERMINATION_TABLE = {
    run_started: null,
    step_started: null,
    step_completed: null,
    prerequisite_missing: 'prerequisite_missing',
    communication_lost: 'communication_interrupted',
    assertion_failed: 'assertion_failed',
};
