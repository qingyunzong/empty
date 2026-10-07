import type { Span } from './ast.ts';

export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export function toRange(source: string, span: Span): SourceRange {
  const position = (offset: number): { line: number; col: number } => {
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  };
  const start = position(span.start);
  const end = position(span.end);
  return {
    start: span.start,
    end: span.end,
    startLine: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
  };
}

export class ExprError extends Error {
  readonly span: Span;
  readonly range: SourceRange;

  constructor(message: string, span: Span, source: string) {
    const range = toRange(source, span);
    super(
      `${message} at line ${range.startLine}, column ${range.startCol} (offset ${span.start}..${span.end})`,
    );
    this.name = new.target.name;
    this.span = span;
    this.range = range;
  }
}

export class ParseError extends ExprError {}

export class EvalError extends ExprError {}

export class BudgetExhaustedError extends Error {
  readonly budget: number;

  constructor(budget: number) {
    super(`Step budget exhausted (budget: ${budget})`);
    this.name = 'BudgetExhaustedError';
    this.budget = budget;
  }
}
