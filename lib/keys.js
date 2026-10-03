'use strict';

// Settlement file name: <merchant>_<YYYY-MM-DD>_<CCY>.csv
// Logical key: merchant|date|currency
const KEY_RE = /^(.+)_(\d{4}-\d{2}-\d{2})_([A-Z]{3})\.csv$/;

function parseFileName(name) {
  const m = KEY_RE.exec(name);
  if (!m) return null;
  return { merchant: m[1], date: m[2], currency: m[3], key: `${m[1]}|${m[2]}|${m[3]}` };
}

function fileNameForKey(key) {
  const [merchant, date, currency] = key.split('|');
  return `${merchant}_${date}_${currency}.csv`;
}

function normalizeKey(s) {
  if (s.includes('|')) return s;
  const parsed = parseFileName(s);
  if (!parsed) throw new Error(`cannot parse key: ${s}`);
  return parsed.key;
}

module.exports = { KEY_RE, parseFileName, fileNameForKey, normalizeKey };
