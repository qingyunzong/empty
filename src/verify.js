'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { crc32 } = require('./crc32');
const { HEADER_LEN, parseHeader, parsePayload } = require('./format');
const { QGError } = require('./errors');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Standalone re-verification of a path certificate against the data file,
// manifest and index. Only the blocks referenced by the certificate are
// read. Old certificates stay valid after appends because the manifest
// commitment is over the prefix of `cert.manifestBlocks` block hashes.
function verifyCertificate(cert, { dataPath, manifestPath, indexPath }) {
  if (!cert || cert.type !== 'qg-path-cert' || cert.version !== 1) {
    throw new QGError('E_CERT', 'not a qg-path-cert v1 certificate');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  if (!Array.isArray(manifest.blocks) || manifest.blocks.length < cert.manifestBlocks) {
    throw new QGError('E_MANIFEST', 'manifest no longer contains the certified blocks');
  }
  const prefix = manifest.blocks.slice(0, cert.manifestBlocks).join('\n');
  if (sha256(Buffer.from(prefix, 'utf8')) !== cert.manifestHash) {
    throw new QGError('E_MANIFEST', 'manifest prefix does not match certificate commitment');
  }
  if (!Array.isArray(index.blocks) || index.blocks.length < cert.manifestBlocks) {
    throw new QGError('E_INDEX', 'index is missing certified blocks');
  }

  const fd = fs.openSync(dataPath, 'r');
  try {
    const seenRecords = [];
    for (const step of cert.steps) {
      const entry = index.blocks[step.block];
      if (!entry || entry.id !== step.block) {
        throw new QGError('E_INDEX', `no index entry for block ${step.block}`);
      }
      const buf = Buffer.alloc(entry.length);
      const got = fs.readSync(fd, buf, 0, entry.length, entry.offset);
      if (got !== entry.length) {
        throw new QGError('E_INDEX', `block ${step.block} extends past end of file`);
      }
      const header = parseHeader(buf);
      if (!header || header.id !== step.block || header.payloadLen !== entry.length - HEADER_LEN) {
        throw new QGError('E_INDEX', `index location for block ${step.block} does not match file layout`);
      }
      const payload = buf.subarray(HEADER_LEN);
      if (crc32(payload) !== header.crc) {
        throw new QGError('E_CRC', `block ${step.block} payload failed CRC32 check`);
      }
      const blockHash = sha256(buf);
      if (blockHash !== manifest.blocks[step.block]) {
        throw new QGError('E_CRC', `block ${step.block} hash does not match manifest`);
      }
      if (blockHash !== step.blockHash) {
        throw new QGError('E_CERT', `certificate block hash mismatch at block ${step.block}`);
      }
      const hit = parsePayload(payload).find((r) => r.offset === step.recordOffset);
      if (!hit || hit.record.lot !== step.lot) {
        throw new QGError('E_CERT', `certificate record offset mismatch for lot "${step.lot}"`);
      }
      if (sha256(hit.bytes) !== step.recordHash) {
        throw new QGError('E_CERT', `certificate record hash mismatch for lot "${step.lot}"`);
      }
      seenRecords.push(hit.record);
    }

    // Connectivity: each step's record must list the next lot as a parent.
    for (let i = 0; i + 1 < cert.steps.length; i++) {
      if (!seenRecords[i].parents.includes(cert.steps[i + 1].lot)) {
        throw new QGError('E_CERT', `path is not connected at "${cert.steps[i].lot}"`);
      }
    }
    if (cert.steps[0].lot !== cert.from || cert.steps[cert.steps.length - 1].lot !== cert.to) {
      throw new QGError('E_CERT', 'certificate endpoints do not match steps');
    }
    if (
      cert.boundary.startHash !== cert.steps[0].recordHash ||
      cert.boundary.endHash !== cert.steps[cert.steps.length - 1].recordHash
    ) {
      throw new QGError('E_CERT', 'certificate boundary hashes do not match steps');
    }
    if (cert.path.join('') !== cert.steps.map((s) => s.lot).join('')) {
      throw new QGError('E_CERT', 'certificate path does not match steps');
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, from: cert.from, to: cert.to, length: cert.steps.length };
}

module.exports = { verifyCertificate };
