'use strict';

const crypto = require('node:crypto');

class CertError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CERT_ERROR';
    this.exitCode = 2;
  }
}

function parseTs(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms / 1000;
  }
  throw new CertError(`invalid timestamp for ${field}: ${JSON.stringify(value)}`);
}

function isoTs(seconds) {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(obj) {
  return sha256(canonicalize(obj));
}

module.exports = { CertError, parseTs, isoTs, canonicalize, sha256, hashObject };
