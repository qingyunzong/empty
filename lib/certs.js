'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CertError, hashObject } = require('./util');

const CERT_SCHEMA = 'vaccine-cert/1';
const INDEX_SCHEMA = 'vaccine-cert-index/1';

function sanitize(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function emptyIndex() {
  return { schema: INDEX_SCHEMA, batches: {} };
}

function loadIndex(certsDir) {
  const file = path.join(certsDir, 'index.json');
  if (!fs.existsSync(file)) return emptyIndex();
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (index.schema !== INDEX_SCHEMA) throw new CertError(`unsupported index schema in ${file}`);
  return index;
}

function saveIndex(certsDir, index) {
  fs.writeFileSync(path.join(certsDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}

function buildCertContent(evaluation, sequence, prevHash) {
  const { shipment, result, adjustments_digest } = evaluation;
  return {
    schema: CERT_SCHEMA,
    batch_id: shipment.batch_id,
    shipment_id: shipment.shipment_id,
    sensor_id: shipment.sensor_id,
    window: { in_ts: shipment.in_ts, out_ts: shipment.out_ts },
    limits: { min_c: shipment.min_c, max_c: shipment.max_c, max_gap_s: shipment.max_gap_s },
    verdict: result.verdict,
    excursion_seconds: result.excursion_seconds,
    unknown_seconds: result.unknown_seconds,
    compliant_seconds: result.compliant_seconds,
    readings_count: result.readings_count,
    adjustments_digest,
    sequence,
    prev_hash: prevHash,
  };
}

function certFileName(batchId, sequence, hash) {
  return `${sanitize(batchId)}-${sequence}-${hash.slice(0, 12)}.json`;
}

// Issue certificates for all evaluated shipments. Idempotent: if the
// recomputed content matches the current chain head, nothing changes.
// Otherwise the old head is revoked and a new cert links to it via prev_hash.
function certify(evaluations, certsDir) {
  fs.mkdirSync(certsDir, { recursive: true });
  const index = loadIndex(certsDir);
  const summary = [];

  for (const evaluation of evaluations) {
    const batchId = evaluation.shipment.batch_id;
    if (!index.batches[batchId]) index.batches[batchId] = { head: null, chain: [] };
    const batch = index.batches[batchId];
    const headEntry = batch.chain.length ? batch.chain[batch.chain.length - 1] : null;

    // Idempotency check: recompute the head's own content (same sequence and
    // prev_hash) and compare hashes. Only issue a new cert when it differs.
    if (headEntry) {
      const headSeq = batch.chain.length - 1;
      const headPrev = batch.chain.length >= 2 ? batch.chain[batch.chain.length - 2].hash : null;
      const headContent = buildCertContent(evaluation, headSeq, headPrev);
      if (hashObject(headContent) === headEntry.hash) {
        summary.push({ batch_id: batchId, hash: headEntry.hash, status: 'unchanged' });
        continue;
      }
    }

    const content = buildCertContent(evaluation, batch.chain.length, headEntry ? headEntry.hash : null);
    const hash = hashObject(content);

    if (headEntry) headEntry.status = 'revoked';
    const file = certFileName(batchId, content.sequence, hash);
    fs.writeFileSync(path.join(certsDir, file), JSON.stringify({ ...content, hash }, null, 2) + '\n');
    batch.chain.push({ hash, file, status: 'active' });
    batch.head = hash;
    summary.push({ batch_id: batchId, hash, status: headEntry ? 'reissued' : 'issued' });
  }

  saveIndex(certsDir, index);
  return summary;
}

function readCert(certsDir, file) {
  const cert = JSON.parse(fs.readFileSync(path.join(certsDir, file), 'utf8'));
  if (cert.schema !== CERT_SCHEMA) throw new CertError(`unsupported cert schema in ${file}`);
  return cert;
}

// Verify every batch chain: cert hashes recompute correctly, prev_hash links
// are intact, and exactly the head is active. Returns a structured report.
function verifyChain(certsDir) {
  const index = loadIndex(certsDir);
  const batches = {};
  let valid = true;

  for (const [batchId, batch] of Object.entries(index.batches)) {
    const problems = [];
    let prevHash = null;
    batch.chain.forEach((entry, i) => {
      let cert;
      try {
        cert = readCert(certsDir, entry.file);
      } catch (err) {
        problems.push(`cert ${entry.file}: unreadable: ${err.message}`);
        return;
      }
      const { hash, ...content } = cert;
      if (hash !== entry.hash) problems.push(`cert ${entry.file}: hash field mismatch with index`);
      if (hashObject(content) !== entry.hash) problems.push(`cert ${entry.file}: content hash mismatch`);
      if (content.sequence !== i) problems.push(`cert ${entry.file}: sequence ${content.sequence} != ${i}`);
      if (content.prev_hash !== prevHash) problems.push(`cert ${entry.file}: broken prev_hash link`);
      const expectedStatus = i === batch.chain.length - 1 ? 'active' : 'revoked';
      if (entry.status !== expectedStatus) problems.push(`cert ${entry.file}: status ${entry.status}, expected ${expectedStatus}`);
      prevHash = entry.hash;
    });
    if (batch.head !== prevHash) problems.push('index head does not match chain tip');
    if (problems.length) valid = false;
    batches[batchId] = { valid: problems.length === 0, problems };
  }

  return { valid, batches };
}

// A certificate is usable only if its chain verifies and it is the active head.
function verifyCert(certsDir, certFile) {
  const index = loadIndex(certsDir);
  const cert = readCert(certsDir, certFile);
  const { hash } = cert;
  const batch = index.batches[cert.batch_id];
  if (!batch) return { usable: false, reason: `unknown batch ${cert.batch_id}` };
  const chainOk = verifyChain(certsDir);
  if (!chainOk.batches[cert.batch_id] || !chainOk.batches[cert.batch_id].valid) {
    return { usable: false, reason: 'chain verification failed' };
  }
  if (batch.head !== hash) return { usable: false, reason: 'certificate revoked (superseded)' };
  return { usable: true, hash, verdict: cert.verdict };
}

module.exports = { certify, verifyChain, verifyCert, loadIndex, buildCertContent, CERT_SCHEMA, INDEX_SCHEMA };
