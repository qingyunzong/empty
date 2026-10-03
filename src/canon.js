'use strict';
const crypto = require('node:crypto');

function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { canon, sha256 };
