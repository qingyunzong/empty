'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ',';
    out += JSON.stringify(keys[i]) + ':' + canonical(value[keys[i]]);
  }
  return out + '}';
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac256hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

module.exports = { canonical, sha256hex, hmac256hex };
