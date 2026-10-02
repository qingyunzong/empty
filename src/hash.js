'use strict';

const crypto = require('node:crypto');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalize(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function viewInputs(viewName, reportId, fields) {
  return { view: viewName, report: reportId, fields };
}

function viewHash(inputs) {
  return sha256hex(canonicalize(inputs));
}

module.exports = { canonicalize, sha256hex, viewInputs, viewHash };
