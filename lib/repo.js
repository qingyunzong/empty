'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_DIR = '.evc';
const EVIDENCE_DIR = 'evidence';
const CLAIMS_FILE = 'claims.json';

class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashObject(obj) {
  return sha256(canonical(obj));
}

function repoPath(root, ...parts) {
  return path.join(root, REPO_DIR, ...parts);
}

function init(root) {
  fs.mkdirSync(repoPath(root, 'objects'), { recursive: true });
  fs.mkdirSync(repoPath(root, 'versions'), { recursive: true });
  const headFile = repoPath(root, 'HEAD');
  if (!fs.existsSync(headFile)) fs.writeFileSync(headFile, '');
  return true;
}

function ensureRepo(root) {
  if (!fs.existsSync(repoPath(root, 'versions'))) {
    throw new Error(`not an evidence-chain repository: ${root} (run "evc init" first)`);
  }
}

function readHead(root) {
  const head = fs.readFileSync(repoPath(root, 'HEAD'), 'utf8').trim();
  return head === '' ? null : head;
}

function writeHead(root, hash) {
  fs.writeFileSync(repoPath(root, 'HEAD'), hash === null ? '' : hash);
}

function versionFile(root, hash) {
  return repoPath(root, 'versions', hash + '.json');
}

function loadVersion(root, hash) {
  const file = versionFile(root, hash);
  if (!fs.existsSync(file)) {
    throw new VerifyError('MISSING_VERSION', `version object not found: ${hash}`);
  }
  let version;
  try {
    version = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new VerifyError('CORRUPT_VERSION', `version object is not valid JSON: ${hash}`);
  }
  const actual = hashObject({
    parent: version.parent,
    message: version.message,
    patch: version.patch,
    claims: version.claims,
  });
  if (actual !== hash) {
    throw new VerifyError(
      'CORRUPT_VERSION',
      `version content hash mismatch: stored as ${hash} but content hashes to ${actual}`,
    );
  }
  return version;
}

// Walk parent links from target back to genesis; return chain genesis-first.
function loadChain(root, targetHash) {
  const chain = [];
  const seen = new Set();
  let cursor = targetHash;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new VerifyError('CORRUPT_VERSION', `cycle detected in version graph at ${cursor}`);
    }
    seen.add(cursor);
    const version = loadVersion(root, cursor);
    chain.unshift({ hash: cursor, version });
    cursor = version.parent;
  }
  return chain;
}

function objectFile(root, hash) {
  return repoPath(root, 'objects', hash);
}

// Verify one blob referenced by a manifest entry.
function checkBlob(root, evidencePath, expectedHash, versionHash) {
  const file = objectFile(root, expectedHash);
  if (!fs.existsSync(file)) {
    throw new VerifyError(
      'MISSING_EVIDENCE',
      `evidence blob missing for "${evidencePath}" (sha256 ${expectedHash}) required by version ${versionHash}`,
    );
  }
  const actual = sha256(fs.readFileSync(file));
  if (actual !== expectedHash) {
    throw new VerifyError(
      'HASH_MISMATCH',
      `hash mismatch for "${evidencePath}" in version ${versionHash}: expected ${expectedHash}, got ${actual}`,
    );
  }
}

function checkClaims(claims, manifest, versionHash) {
  for (const claim of claims) {
    for (const ref of claim.evidence || []) {
      if (!(ref in manifest)) {
        throw new VerifyError(
          'DANGLING_CLAIM',
          `claim "${claim.id}" references deleted/unknown evidence "${ref}" in version ${versionHash}`,
        );
      }
    }
  }
}

// Incrementally verify the chain from genesis to targetHash (default HEAD).
// Returns { certificate, manifest, chain } on success; throws VerifyError otherwise.
function verify(root, targetHash) {
  ensureRepo(root);
  const target = targetHash || readHead(root);
  if (target === null) {
    throw new VerifyError('EMPTY_REPO', 'repository has no commits yet');
  }
  const chain = loadChain(root, target);
  const manifest = {};
  for (const { hash, version } of chain) {
    for (const p of version.patch.delete || []) {
      delete manifest[p];
    }
    for (const [p, h] of Object.entries(version.patch.upsert || {})) {
      checkBlob(root, p, h, hash);
      manifest[p] = h;
    }
    checkClaims(version.claims || [], manifest, hash);
  }
  const parentHash = chain[chain.length - 1].version.parent;
  const certificate = {
    version: target,
    contentHash: target,
    parentHash,
    certificateHash: sha256(target + ':' + (parentHash === null ? 'null' : parentHash)),
  };
  fs.writeFileSync(repoPath(root, 'certificate.json'), JSON.stringify(certificate, null, 2) + '\n');
  return { certificate, manifest, chain };
}

function listEvidenceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const relPath = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(dir, '');
  return out.sort();
}

function normalizeClaims(raw) {
  if (!Array.isArray(raw)) throw new Error('claims.json must contain a JSON array');
  return raw.map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new Error(`claim #${i} must be an object`);
    return {
      id: String(c.id ?? `claim-${i}`),
      text: String(c.text ?? ''),
      evidence: Array.isArray(c.evidence) ? c.evidence.map(String) : [],
    };
  });
}

function commit(root, message) {
  ensureRepo(root);
  const evidenceDir = path.join(root, EVIDENCE_DIR);
  const files = listEvidenceFiles(evidenceDir);
  const newManifest = {};
  for (const rel of files) {
    const content = fs.readFileSync(path.join(evidenceDir, rel));
    const hash = sha256(content);
    newManifest[rel] = hash;
    const dest = objectFile(root, hash);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, content);
  }

  const claimsFile = path.join(root, CLAIMS_FILE);
  const claims = fs.existsSync(claimsFile)
    ? normalizeClaims(JSON.parse(fs.readFileSync(claimsFile, 'utf8')))
    : [];

  const parent = readHead(root);
  const parentManifest = parent === null ? {} : verify(root, parent).manifest;

  const upsert = {};
  for (const [p, h] of Object.entries(newManifest)) {
    if (parentManifest[p] !== h) upsert[p] = h;
  }
  const deleted = Object.keys(parentManifest).filter((p) => !(p in newManifest)).sort();

  // A claim may never reference evidence that is absent from the new manifest.
  checkClaims(claims, newManifest, '(pending commit)');

  const version = {
    parent,
    message: String(message || ''),
    patch: { upsert, delete: deleted },
    claims,
  };
  const hash = hashObject(version);
  fs.writeFileSync(versionFile(root, hash), JSON.stringify(version, null, 2) + '\n');
  writeHead(root, hash);
  return { hash, version };
}

// Rebuild the full manifest of targetHash purely from the stored patch chain
// (never from the current workspace), then materialize it into destDir.
// Verification runs first: on failure nothing in destDir is touched.
function checkout(root, targetHash, destDir) {
  ensureRepo(root);
  const { manifest } = verify(root, targetHash); // throws VerifyError on corruption
  const dest = destDir || path.join(root, 'checkout');
  const tmp = dest + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [rel, hash] of Object.entries(manifest)) {
      const target = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(objectFile(root, hash), target);
    }
    fs.writeFileSync(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ version: targetHash, files: manifest }, null, 2) + '\n',
    );
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { dest, manifest };
}

module.exports = {
  REPO_DIR,
  VerifyError,
  sha256,
  canonical,
  hashObject,
  init,
  commit,
  verify,
  checkout,
  readHead,
  loadChain,
};
