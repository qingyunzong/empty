'use strict';

class ReconError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Minimal RFC4180-style CSV parser: quoted fields, "" escapes, embedded
// commas/newlines inside quotes, CRLF tolerated. Blank lines are skipped.
function parseCsv(text, file) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { pushRow(); i += 1; continue; }
    field += c; i += 1;
  }
  if (inQuotes) throw new ReconError('E_SCHEMA', `${file}: unterminated quoted field`);
  if (field !== '' || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

module.exports = { parseCsv, ReconError };
