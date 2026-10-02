'use strict';

const { parse, parseExpr, tokenize } = require('./parser');
const { elaborate, typeOfExpr, normalizeExpr, Scope } = require('./semantics');
const { certify, buildDocument, verifyDocument, hmac } = require('./cert');
const { Session } = require('./session');

// Convenience pipeline: source text -> certified document.
function compile(source, key) {
  const commits = elaborate(parse(source));
  return buildDocument(commits, key);
}

module.exports = {
  parse,
  parseExpr,
  tokenize,
  elaborate,
  typeOfExpr,
  normalizeExpr,
  Scope,
  certify,
  buildDocument,
  verifyDocument,
  hmac,
  Session,
  compile,
};
