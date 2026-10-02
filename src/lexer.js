const DIRECTIVES = new Set(['correction', 'table']);
const TWO_CHAR_SYMBOLS = new Set(['==', '!=', '>=', '<=']);
const ONE_CHAR_SYMBOLS = new Set(['=', '>', '<', '[', ']', '(', ')', ',']);

function lexString(line, start, lineNo) {
  const quote = line[start];
  let value = '';
  let i = start + 1;
  while (i < line.length && line[i] !== quote) {
    if (line[i] === '\\') {
      if (i + 1 >= line.length) break;
      value += line[i + 1];
      i += 2;
    } else {
      value += line[i];
      i += 1;
    }
  }
  if (i >= line.length) {
    throw new SyntaxError(`Unterminated string at line ${lineNo}`);
  }
  return { token: { type: 'STRING', value, line: lineNo }, next: i + 1 };
}

function lexStatement(line, lineNo) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const { token, next } = lexString(line, i, lineNo);
      tokens.push(token);
      i = next;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?/.exec(line.slice(i));
    if (numberMatch && (ch !== '-' || /\d/.test(line[i + 1] ?? ''))) {
      tokens.push({ type: 'NUMBER', value: parseFloat(numberMatch[0]), line: lineNo });
      i += numberMatch[0].length;
      continue;
    }
    const identMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(line.slice(i));
    if (identMatch) {
      tokens.push({ type: 'IDENT', value: identMatch[0], line: lineNo });
      i += identMatch[0].length;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (TWO_CHAR_SYMBOLS.has(two)) {
      tokens.push({ type: 'SYMBOL', value: two, line: lineNo });
      i += 2;
      continue;
    }
    if (ONE_CHAR_SYMBOLS.has(ch)) {
      tokens.push({ type: 'SYMBOL', value: ch, line: lineNo });
      i += 1;
      continue;
    }
    throw new SyntaxError(`Unexpected character '${ch}' at line ${lineNo}`);
  }
  return tokens;
}

function lexCsvRow(line, lineNo) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  let wasQuoted = false;
  const pushCell = () => {
    let value;
    if (wasQuoted) {
      value = current;
    } else if (/^-?\d+(\.\d+)?$/.test(current.trim())) {
      value = parseFloat(current.trim());
    } else {
      value = current.trim();
    }
    cells.push(value);
    current = '';
    wasQuoted = false;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (ch === ',') {
      pushCell();
    } else {
      current += ch;
    }
  }
  if (inQuotes) {
    throw new SyntaxError(`Unterminated quoted CSV cell at line ${lineNo}`);
  }
  pushCell();
  return { kind: 'csv', cells, line: lineNo };
}

// Splits the script source into lexed lines. A `#!correction` directive puts
// the lexer into statement mode; a `#!table` directive puts it into CSV mode.
// Quoted strings are always lexed as a single token/cell, so commas inside
// quotes never split a field.
export function lex(source) {
  const lines = [];
  let mode = 'statement';
  const rawLines = String(source).split(/\r?\n/);
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const lineNo = idx + 1;
    const text = rawLines[idx].trim();
    if (text === '') continue;
    if (text.startsWith('#!')) {
      const parts = text.slice(2).split(/\s+/).filter(Boolean);
      const name = parts[0];
      if (!DIRECTIVES.has(name)) {
        throw new SyntaxError(`Unknown directive '#!${name}' at line ${lineNo}`);
      }
      mode = name === 'table' ? 'csv' : 'statement';
      lines.push({ kind: 'directive', name, args: parts.slice(1), line: lineNo });
      continue;
    }
    if (text.startsWith('#')) continue;
    if (mode === 'csv') {
      lines.push(lexCsvRow(text, lineNo));
    } else {
      lines.push({ kind: 'statement', tokens: lexStatement(text, lineNo), line: lineNo });
    }
  }
  return lines;
}
