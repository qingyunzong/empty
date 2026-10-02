'use strict';

class LineError extends Error {
  constructor(code, line, detail) {
    super(detail ? `${code} at line ${line}: ${detail}` : `${code} at line ${line}`);
    this.name = 'LineError';
    this.code = code;
    this.line = line;
  }
}

// Parse JSONL text into [{ value, line }]. Blank lines are skipped.
// Throws LineError({code:'E_PARSE', line}) on malformed JSON.
function parseJsonl(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LineError('E_PARSE', i + 1, 'invalid JSON');
    }
    records.push({ value, line: i + 1 });
  }
  return records;
}

module.exports = { LineError, parseJsonl };
