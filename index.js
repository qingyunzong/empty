'use strict';

const { diffBooks } = require('./src/diff');
const { verifyCertificate, buildRejectCertificate } = require('./src/certificate');
const { compileBook, productExplore, jointAcceptable } = require('./src/automaton');
const { minRepairScripts, genOps, applyOp, applyScript } = require('./src/repair');
const model = require('./src/model');

module.exports = {
  diffBooks,
  verifyCertificate,
  buildRejectCertificate,
  compileBook,
  productExplore,
  jointAcceptable,
  minRepairScripts,
  genOps,
  applyOp,
  applyScript,
  ReconError: model.ReconError,
  MAX_EVENTS_PER_BOOK: model.MAX_EVENTS_PER_BOOK,
};
