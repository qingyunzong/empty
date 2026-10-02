'use strict';

const { createHash } = require('node:crypto');

const GENESIS = '0'.repeat(64);

function hashRecord(rec) {
  return createHash('sha256').update(JSON.stringify(rec), 'utf8').digest('hex');
}

function appendCertificate(chain, record) {
  const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : GENESIS;
  const body = { index: chain.length, ...record, prevHash };
  const entry = { ...body, hash: hashRecord(body) };
  chain.push(entry);
  return entry;
}

function verifyChain(chain) {
  if (!Array.isArray(chain)) return false;
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (typeof entry !== 'object' || entry === null || typeof entry.hash !== 'string') return false;
    const { hash, ...body } = entry;
    if (body.index !== i || body.prevHash !== prev) return false;
    if (hashRecord(body) !== hash) return false;
    prev = hash;
  }
  return true;
}

module.exports = { appendCertificate, verifyChain, GENESIS };
