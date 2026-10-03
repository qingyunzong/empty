"use strict";

// Minimal RFC4180-style CSV parser: quoted fields, "" escapes, CRLF/LF,
// embedded newlines inside quotes. Returns an array of rows (arrays of strings).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      started = true;
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    field += c;
    started = true;
    i++;
  }
  if (started || field.length > 0 || row.length > 0) endRow();
  return rows;
}

function parseTable(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { header: [], rows: [] };
  return { header: rows[0], rows: rows.slice(1) };
}

module.exports = { parseCSV, parseTable };
