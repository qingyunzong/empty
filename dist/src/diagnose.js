import { TERMINATION_TABLE, } from './events.js';
/**
 * 选取“最早直接致终止事件”：
 * 在具备终止证据（terminatesRun === true）且种类可分类的事件中，
 * 取 at 最小者；at 相同取输入顺序靠前者。
 */
function selectTerminalEvent(events) {
    let selected = null;
    for (const event of events) {
        if (event.terminatesRun !== true)
            continue;
        if (TERMINATION_TABLE[event.kind] === null)
            continue;
        if (selected === null || event.at < selected.at) {
            selected = event;
        }
    }
    return selected;
}
/**
 * 从终止事件沿 causeIds 回溯，收集全部传递原因，
 * 按 (at, 输入顺序) 排序，保证原因先于结果，终止事件在末尾。
 * 对循环引用安全（每个事件只展开一次）。
 */
function buildCausalChain(terminal, byId, inputOrder) {
    const visited = new Set([terminal.id]);
    const missing = new Set();
    const causes = [];
    const walk = (event) => {
        for (const causeId of event.causeIds ?? []) {
            if (visited.has(causeId))
                continue;
            visited.add(causeId);
            const cause = byId.get(causeId);
            if (cause === undefined) {
                missing.add(causeId);
                continue;
            }
            causes.push(cause);
            walk(cause);
        }
    };
    walk(terminal);
    causes.sort((a, b) => {
        if (a.at !== b.at)
            return a.at - b.at;
        return (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0);
    });
    return { chain: [...causes, terminal], missingCauseIds: [...missing] };
}
/**
 * 诊断一次运行的结构化事件流。
 *
 * 规则：
 * - 没有任何具备终止证据的事件 -> unknown（没有执行证据）。
 * - 存在多个终止候选时，按最早直接致终止事件定类。
 * - 类别由有限表 TERMINATION_TABLE 按 kind 查得，不解析文本。
 */
export function diagnose(events) {
    const byId = new Map();
    const inputOrder = new Map();
    events.forEach((event, index) => {
        if (!byId.has(event.id)) {
            byId.set(event.id, event);
            inputOrder.set(event.id, index);
        }
    });
    const terminal = selectTerminalEvent(events);
    if (terminal === null) {
        return {
            category: 'unknown',
            terminalEventId: null,
            causalChain: [],
            missingCauseIds: [],
            reason: '没有观测到任何直接终止运行的执行证据，分类为 unknown。',
        };
    }
    const category = TERMINATION_TABLE[terminal.kind];
    if (category === null) {
        // selectTerminalEvent 已过滤，此处不可达；保留以满足类型收窄。
        throw new Error(`unreachable: kind ${terminal.kind} has no category`);
    }
    const { chain, missingCauseIds } = buildCausalChain(terminal, byId, inputOrder);
    return {
        category,
        terminalEventId: terminal.id,
        causalChain: chain,
        missingCauseIds,
        reason: `事件 ${terminal.id}（kind=${terminal.kind}）是最早的直接终止事件，` +
            `按有限表分类为 ${category}；因果链含 ${chain.length} 个事件。`,
    };
}
