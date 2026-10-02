export class TemplateError extends Error {
  constructor(message, phase) {
    super(message);
    this.name = 'TemplateError';
    this.phase = phase; // 'lex' | 'parse' | 'render'
  }
}
