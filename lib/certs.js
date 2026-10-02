'use strict';

const { sha256 } = require('./checksum');

const GENESIS = 'GENESIS';

function certHash(cert) {
  const { hash, ...rest } = cert;
  return sha256(JSON.stringify(rest));
}

// Append a hash-chained certificate. Every restore/evict/correct action leaves
// evidence that can be independently re-verified after the fact.
function appendCert(chain, entry) {
  const cert = {
    seq: chain.length,
    ...entry,
    prevHash: chain.length ? chain[chain.length - 1].hash : GENESIS,
  };
  cert.hash = certHash(cert);
  chain.push(cert);
  return cert;
}

function verifyChain(chain) {
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (cert.seq !== i) return { ok: false, index: i, reason: 'bad-seq' };
    const expectedPrev = i === 0 ? GENESIS : chain[i - 1].hash;
    if (cert.prevHash !== expectedPrev) return { ok: false, index: i, reason: 'bad-prevHash' };
    if (cert.hash !== certHash(cert)) return { ok: false, index: i, reason: 'bad-hash' };
  }
  return { ok: true };
}

module.exports = { appendCert, verifyChain, GENESIS };
