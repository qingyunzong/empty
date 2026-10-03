'use strict';

function splitLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parse(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const fields = splitLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = fields[i] === undefined ? '' : fields[i];
    });
    return row;
  });
}

function escapeField(value) {
  const s = String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function stringify(rows, columns) {
  const out = [columns.join(',')];
  for (const row of rows) {
    out.push(columns.map((c) => escapeField(row[c] === undefined ? '' : row[c])).join(','));
  }
  return out.join('\n') + '\n';
}

module.exports = { parse, stringify };
