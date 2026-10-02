'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.details = details === undefined ? null : details;
  }
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashRecord(record) {
  return sha256(canonical(record));
}

function atomicWriteSync(path, data) {
  const tmp = path + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
}

function readJsonSync(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJsonSync(path, value) {
  atomicWriteSync(path, JSON.stringify(value, null, 2) + '\n');
}

module.exports = { SyncError, sha256, canonical, hashRecord, atomicWriteSync, readJsonSync, writeJsonSync };
