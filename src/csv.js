// Minimal RFC4180-ish CSV parser (stdlib only).
export class ReconError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseCsv(text, fileName) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let line = 1;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    // skip a completely empty trailing line
    if (record.length === 1 && record[0] === '' && rows.length >= 0) {
      // treat single empty field line as blank line: ignore
      record = [];
      return;
    }
    rows.push({ record, line });
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      if (c === '\n') line++;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\n') { line++; pushRecord(); continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || record.length > 0) pushRecord();
  if (rows.length === 0) {
    throw new ReconError('E_SCHEMA', `${fileName}: missing header row`);
  }
  return rows;
}

// Validate header + coerce rows into typed records.
// spec: [{ name, type: 'string'|'number'|'date' }]  number: '' -> null (NULL)
export function toTable(text, fileName, spec) {
  const parsed = parseCsv(text, fileName);
  const header = parsed[0].record.map((h) => h.trim());
  const colIndex = new Map();
  header.forEach((h, i) => {
    if (colIndex.has(h)) {
      throw new ReconError('E_SCHEMA', `${fileName}: duplicate column "${h}"`);
    }
    colIndex.set(h, i);
  });
  for (const col of spec) {
    if (!colIndex.has(col.name)) {
      throw new ReconError('E_SCHEMA', `${fileName}: missing required column "${col.name}"`);
    }
  }
  const rows = [];
  for (let r = 1; r < parsed.length; r++) {
    const { record, line } = parsed[r];
    if (record.length !== header.length) {
      throw new ReconError('E_SCHEMA', `${fileName}:${line}: expected ${header.length} fields, got ${record.length}`);
    }
    const obj = {};
    for (const col of spec) {
      const raw = record[colIndex.get(col.name)].trim();
      if (col.type === 'number') {
        if (raw === '') { obj[col.name] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new ReconError('E_SCHEMA', `${fileName}:${line}: column "${col.name}" is not a number: "${raw}"`);
        }
        obj[col.name] = n;
      } else if (col.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          throw new ReconError('E_SCHEMA', `${fileName}:${line}: column "${col.name}" is not a YYYY-MM-DD date: "${raw}"`);
        }
        obj[col.name] = raw;
      } else {
        if (raw === '') {
          throw new ReconError('E_SCHEMA', `${fileName}:${line}: column "${col.name}" must not be empty`);
        }
        obj[col.name] = raw;
      }
    }
    rows.push(obj);
  }
  return rows;
}
