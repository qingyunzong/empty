export class LexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LexError';
  }
}

// A log line is either:
//   note: <free text>            -> NOTE token (carried as metadata, never executed)
//   evt k=v k=v ...              -> EVENT token with structured fields
// Blank lines and `#` comments are skipped. Anything else is a lexical error.
export function lex(source) {
  const tokens = [];
  const lines = String(source).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineno = index + 1;
    if (line === '' || line.startsWith('#')) return;
    if (line.startsWith('note:')) {
      tokens.push({ type: 'NOTE', text: line.slice('note:'.length).trim(), line: lineno });
      return;
    }
    if (line === 'evt' || line.startsWith('evt ')) {
      const fields = {};
      const rest = line.slice(3).trim();
      if (rest !== '') {
        for (const part of rest.split(/\s+/)) {
          const eq = part.indexOf('=');
          if (eq <= 0) {
            throw new LexError(`line ${lineno}: malformed field "${part}" (expected key=value)`);
          }
          const key = part.slice(0, eq);
          if (Object.prototype.hasOwnProperty.call(fields, key)) {
            throw new LexError(`line ${lineno}: duplicate field "${key}"`);
          }
          fields[key] = part.slice(eq + 1);
        }
      }
      tokens.push({ type: 'EVENT', fields, line: lineno });
      return;
    }
    throw new LexError(`line ${lineno}: unrecognized line (expected "evt ..." or "note: ...")`);
  });
  return tokens;
}
