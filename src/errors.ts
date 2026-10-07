export interface SourcePosition {
  /** 0-based byte/char offset into the template source. */
  readonly offset: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
}

export type TemplateErrorCode =
  | 'SYNTAX_ERROR'
  | 'SECURITY_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'TYPE_ERROR'
  | 'UNBOUND_IDENTIFIER'
  | 'UNKNOWN_FILTER';

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly position: SourcePosition;

  constructor(code: TemplateErrorCode, message: string, position: SourcePosition) {
    super(`${message} (at line ${position.line}, column ${position.column})`);
    this.name = 'TemplateError';
    this.code = code;
    this.position = position;
  }
}

/** Maps offsets in a source string to line/column positions. */
export class SourceMap {
  private readonly lineStarts: number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  positionAt(offset: number): SourcePosition {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { offset, line: low + 1, column: offset - this.lineStarts[low]! + 1 };
  }
}
