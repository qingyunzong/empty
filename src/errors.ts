/** Syntax error reported with a UTF-8 byte position (`pos`). */
export class RuleSyntaxError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (byte ${pos})`);
    this.name = "RuleSyntaxError";
    this.pos = pos;
  }
}

/** Evaluation error reported with the byte position of the offending AST node. */
export class RuleEvaluationError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (byte ${pos})`);
    this.name = "RuleEvaluationError";
    this.pos = pos;
  }
}
