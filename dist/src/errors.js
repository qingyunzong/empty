/** 语法错误：bytePos 为源串中的 UTF-8 字节偏移（从 0 开始）。 */
export class RuleSyntaxError extends Error {
    bytePos;
    constructor(message, bytePos) {
        super(`${message}（字节位置 ${bytePos}）`);
        this.name = 'RuleSyntaxError';
        this.bytePos = bytePos;
    }
}
/** 求值错误：bytePos 为触发错误的 AST 节点在源串中的字节偏移。 */
export class RuleEvalError extends Error {
    kind;
    bytePos;
    constructor(kind, message, bytePos) {
        super(`${message}（字节位置 ${bytePos}）`);
        this.name = 'RuleEvalError';
        this.kind = kind;
        this.bytePos = bytePos;
    }
}
