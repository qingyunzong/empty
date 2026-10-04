'use strict';
const { sha256hex } = require('./util');

// Per-transaction decision certificate: all WAL records (coordinator and
// participants) mentioning the tx, ordered by (virtual ts, node, hash) and
// folded into a hash chain: link_i = sha256(link_{i-1} | walHash_i).
function buildCertificates(wals, txIds) {
  const certs = [];
  for (const tx of txIds) {
    const records = [];
    for (const wal of wals) {
      for (const r of wal.records) if (r.tx === tx) records.push(r);
    }
    records.sort((a, b) => a.ts - b.ts || (a.node < b.node ? -1 : a.node > b.node ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    let link = 'GENESIS';
    const chain = records.map((r) => {
      link = sha256hex(link + '|' + r.hash);
      return { node: r.node, ts: r.ts, type: r.type, data: r.data, walHash: r.hash, link };
    });
    certs.push({ tx, head: chain.length ? chain[chain.length - 1].link : 'GENESIS', records: chain });
  }
  return certs;
}

function verifyCertificate(cert) {
  let link = 'GENESIS';
  for (const r of cert.records) link = sha256hex(link + '|' + r.walHash);
  return link === cert.head;
}

function chainHeads(heads) {
  let link = 'GENESIS';
  for (const h of heads) link = sha256hex(link + '|' + h);
  return link;
}

module.exports = { buildCertificates, verifyCertificate, chainHeads };
