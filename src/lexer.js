// Lexer: distinguishes plain CSV lines, #!correction directive blocks and
// quoted strings (both inside directives and inside CSV fields).

export function lex(source) {
  const tokens = [];
  let inDirective = false;
  const lines = source.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('#!correction')) {
      if (inDirective) throw new SyntaxError(`nested #!correction at line ${lineNo}`);
      inDirective = true;
      tokens.push({ type: 'DIRECTIVE_BEGIN', line: lineNo });
      return;
    }
    if (line.startsWith('#!end')) {
      if (!inDirective) throw new SyntaxError(`#!end without #!correction at line ${lineNo}`);
      inDirective = false;
      tokens.push({ type: 'DIRECTIVE_END', line: lineNo });
      return;
    }
    if (inDirective) {
      tokens.push({ type: 'STATEMENT', line: lineNo, tokens: lexStatement(line, lineNo) });
    } else {
      tokens.push({ type: 'CSV', line: lineNo, fields: parseCsvLine(line, lineNo) });
    }
  });
  if (inDirective) throw new SyntaxError('unterminated #!correction block');
  return tokens;
}

function lexStatement(line, lineNo) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < line.length && line[j] !== '"') { value += line[j]; j++; }
      if (j >= line.length) throw new SyntaxError(`unterminated string at line ${lineNo}`);
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('><=+-*/()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(line.slice(i));
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new SyntaxError(`unexpected character "${ch}" at line ${lineNo}`);
  }
  return tokens;
}

export function parseCsvLine(line, lineNo) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuotes) throw new SyntaxError(`unterminated quoted string in CSV at line ${lineNo}`);
  fields.push(current);
  return fields;
}
