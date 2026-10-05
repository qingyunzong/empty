export interface SourceRange {
  start: number;
  end: number;
}

function lineAndColumn(template: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const stop = Math.min(offset, template.length);
  for (let i = 0; i < stop; i++) {
    if (template[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export class TemplateError extends Error {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
  related?: SourceRange;

  constructor(message: string, template: string, range: SourceRange) {
    const { line, column } = lineAndColumn(template, range.start);
    super(`${message} (line ${line}, column ${column})`);
    this.name = new.target.name;
    this.start = range.start;
    this.end = range.end;
    this.line = line;
    this.column = column;
    this.snippet = template.slice(range.start, range.end);
  }
}

export class TemplateSyntaxError extends TemplateError {}

export class RenderError extends TemplateError {
  readonly path?: string;

  constructor(message: string, template: string, range: SourceRange, path?: string) {
    super(message, template, range);
    this.path = path;
  }
}

export class ExpansionLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Expansion limit exceeded: output would exceed ${limit} characters`);
    this.name = 'ExpansionLimitError';
    this.limit = limit;
  }
}
