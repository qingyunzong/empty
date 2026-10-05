export interface SourcePosition {
  /** 0-based character offset into the template source. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export class TemplateError extends Error {
  readonly position: SourcePosition | undefined;

  constructor(message: string, position?: SourcePosition) {
    super(
      position
        ? `${message} (at line ${position.line}, column ${position.column})`
        : message
    );
    this.name = new.target.name;
    this.position = position;
  }
}

/** Template could not be tokenized or parsed. */
export class TemplateSyntaxError extends TemplateError {}

/** Access violated the security policy (denied key, prototype chain, accessor, method). */
export class SecurityError extends TemplateError {}

/** Loop/filter step budget was exhausted. */
export class BudgetExceededError extends TemplateError {}

/** A cyclic object reference was detected. */
export class CycleError extends TemplateError {}
