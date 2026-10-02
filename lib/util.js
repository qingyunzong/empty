'use strict';

const crypto = require('crypto');

function sha256(data) {
  return crypto.hash('sha256', data, 'hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// 文件键 = 商户 + 日期 + 币种, 文件名形如 m001_2026-09-15_CNY.csv
const KEY_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)_(\d{4}-\d{2}-\d{2})_([A-Z]{3})\.csv$/;

function keyFromFileName(name) {
  const m = KEY_RE.exec(name);
  return m ? `${m[1]}|${m[2]}|${m[3]}` : null;
}

function fileNameForKey(key) {
  return key.split('|').join('_') + '.csv';
}

module.exports = { sha256, stableStringify, keyFromFileName, fileNameForKey, KEY_RE };
