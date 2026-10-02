// Diagnostic error carrying rule-file line/col or event sequence number.
export class DiagnosticError extends Error {
  constructor(message, { phase, line = null, col = null, event = null } = {}) {
    super(message);
    this.name = 'DiagnosticError';
    this.phase = phase; // 'lex' | 'parse' | 'check' | 'event'
    this.line = line;   // 1-based line in the rules file (or event line for phase 'event')
    this.col = col;     // 1-based column in the rules file
    this.event = event; // 1-based event sequence number (JSONL line)
  }
  toJSON() {
    const out = { message: this.message, phase: this.phase };
    if (this.line != null) out.line = this.line;
    if (this.col != null) out.col = this.col;
    if (this.event != null) out.event = this.event;
    return out;
  }
}
