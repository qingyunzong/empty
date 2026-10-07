/** 语法错误：bytePos 为源串中的 UTF-8 字节偏移（从 0 开始）。 */
export class RuleSyntaxError extends Error {
  readonly bytePos: number;
  constructor(message: string, bytePos: number) {
    super(`${message}（字节位置 ${bytePos}）`);
    this.name = 'RuleSyntaxError';
    this.bytePos = bytePos;
  }
}

export type EvalErrorKind = 'unknown-field' | 'null-ordering' | 'type-mismatch' | 'not-boolean';

/** 求值错误：bytePos 为触发错误的 AST 节点在源串中的字节偏移。 */
export class RuleEvalError extends Error {
  readonly kind: EvalErrorKind;
  readonly bytePos: number;
  constructor(kind: EvalErrorKind, message: string, bytePos: number) {
    super(`${message}（字节位置 ${bytePos}）`);
    this.name = 'RuleEvalError';
    this.kind = kind;
    this.bytePos = bytePos;
  }
}
