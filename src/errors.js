export class DslError extends Error {
  constructor(message, line = 0, col = 0, file = null) {
    super(message);
    this.name = 'DslError';
    this.line = line;
    this.col = col;
    this.file = file;
  }

  format() {
    const where = this.file ? `${this.file}:` : '';
    return `${where}${this.line}:${this.col}: error: ${this.message}`;
  }
}
