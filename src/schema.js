'use strict';

const crypto = require('node:crypto');
const { QuerySchemaError } = require('./errors');

const FIELD_TYPES = new Set(['string', 'number', 'date', 'boolean']);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function validateSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new QuerySchemaError('schema must be an object');
  }
  if (schema.fields === null || typeof schema.fields !== 'object' || Array.isArray(schema.fields)) {
    throw new QuerySchemaError('schema.fields must be an object');
  }
  for (const [name, def] of Object.entries(schema.fields)) {
    if (def === null || typeof def !== 'object' || !FIELD_TYPES.has(def.type)) {
      throw new QuerySchemaError(
        `field '${name}' has invalid type; expected one of ${[...FIELD_TYPES].join(', ')}`
      );
    }
  }
  return schema;
}

function hashSchema(schema) {
  return crypto.createHash('sha256').update(canonicalJson(schema)).digest('hex');
}

function stringFields(schema) {
  return Object.keys(schema.fields).filter((name) => schema.fields[name].type === 'string');
}

module.exports = { canonicalize, canonicalJson, validateSchema, hashSchema, stringFields, FIELD_TYPES };
