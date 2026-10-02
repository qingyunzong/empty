'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_DIR = '.evchain';
const EVIDENCE_DIR = 'evidence';
const CLAIMS_FILE = 'claims.json';
const CHECKOUT_DIR = 'checkout';

class EvchainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvchainError';
    this.code = code;
  }
}

const ERR = {
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  HASH_MISMATCH: 'HASH_MISMATCH',
  DANGLING_CLAIM: 'DANGLING_CLAIM',
  CORRUPT_VERSION: 'CORRUPT_VERSION',
  PATCH_MISMATCH: 'PATCH_MISMATCH',
  NOT_A_REPO: 'NOT_A_REPO',
  UNKNOWN_VERSION: 'UNKNOWN_VERSION',
};

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

function repoPath(root, ...parts) {
  return path.join(root, REPO_DIR, ...parts);
}

function isRepo(root) {
  return fs.existsSync(repoPath(root, 'versions')) && fs.existsSync(repoPath(root, 'HEAD'));
}

function readHead(root) {
  return fs.readFileSync(repoPath(root, 'HEAD'), 'utf8').trim();
}

function writeHead(root, hash) {
  fs.writeFileSync(repoPath(root, 'HEAD'), hash + '\n');
}

function versionHash(version) {
  return sha256(canonical(version));
}

function storeVersion(root, version) {
  const hash = versionHash(version);
  fs.writeFileSync(repoPath(root, 'versions', hash + '.json'), canonical(version));
  return hash;
}

function loadVersion(root, hash) {
  const file = repoPath(root, 'versions', hash + '.json');
  if (!fs.existsSync(file)) {
    throw new EvchainError(ERR.CORRUPT_VERSION, `version object missing: ${hash}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new EvchainError(ERR.CORRUPT_VERSION, `version object unreadable: ${hash}`);
  }
  if (versionHash(parsed) !== hash) {
    throw new EvchainError(ERR.HASH_MISMATCH, `version object tampered: ${hash}`);
  }
  return parsed;
}

function storeBlob(root, content) {
  const hash = sha256(content);
  const file = repoPath(root, 'objects', hash);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  return hash;
}

function listEvidenceFiles(root) {
  const base = path.join(root, EVIDENCE_DIR);
  const out = [];
  if (!fs.existsSync(base)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(base);
  out.sort();
  return out.map((f) => path.relative(base, f).split(path.sep).join('/'));
}

function readWorkspaceClaims(root) {
  const file = path.join(root, CLAIMS_FILE);
  if (!fs.existsSync(file)) return [];
  const claims = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(claims)) throw new EvchainError(ERR.CORRUPT_VERSION, 'claims.json must be an array');
  return claims;
}

function validateClaims(claims, manifest) {
  for (const claim of claims) {
    const refs = (claim && claim.evidence) || [];
    for (const ref of refs) {
      if (!(ref in manifest)) {
        const id = claim && claim.id !== undefined ? claim.id : '<unknown>';
        throw new EvchainError(
          ERR.DANGLING_CLAIM,
          `claim ${id} references missing evidence: ${ref}`
        );
      }
    }
  }
}

function computePatch(oldFiles, newFiles, oldClaims, newClaims) {
  const added = {};
  const modified = {};
  const removed = [];
  for (const [p, h] of Object.entries(newFiles)) {
    if (!(p in oldFiles)) added[p] = h;
    else if (oldFiles[p] !== h) modified[p] = { from: oldFiles[p], to: h };
  }
  for (const p of Object.keys(oldFiles)) {
    if (!(p in newFiles)) removed.push(p);
  }
  removed.sort();
  const claimKey = (c) => canonical(c);
  const oldSet = new Set(oldClaims.map(claimKey));
  const newSet = new Set(newClaims.map(claimKey));
  return {
    files: { added, modified, removed },
    claims: {
      added: newClaims.filter((c) => !oldSet.has(claimKey(c))),
      removed: oldClaims.filter((c) => !newSet.has(claimKey(c))),
    },
  };
}

function applyPatch(files, claims, patch) {
  const nextFiles = { ...files };
  for (const p of patch.files.removed) delete nextFiles[p];
  for (const [p, h] of Object.entries(patch.files.added)) nextFiles[p] = h;
  for (const [p, m] of Object.entries(patch.files.modified)) nextFiles[p] = m.to;
  const removedSet = new Set(patch.claims.removed.map((c) => canonical(c)));
  const nextClaims = claims.filter((c) => !removedSet.has(canonical(c)));
  nextClaims.push(...patch.claims.added);
  return { files: nextFiles, claims: nextClaims };
}

function initRepo(root) {
  if (isRepo(root)) throw new EvchainError(ERR.NOT_A_REPO, 'repository already initialized');
  fs.mkdirSync(repoPath(root, 'objects'), { recursive: true });
  fs.mkdirSync(repoPath(root, 'versions'), { recursive: true });
  fs.mkdirSync(repoPath(root, 'certs'), { recursive: true });
  const genesis = {
    parent: null,
    files: {},
    claims: [],
    patch: null,
    message: 'genesis',
    time: new Date().toISOString(),
  };
  const hash = storeVersion(root, genesis);
  writeHead(root, hash);
  return hash;
}

function commit(root, message) {
  if (!isRepo(root)) throw new EvchainError(ERR.NOT_A_REPO, 'not an evchain repository');
  const files = {};
  for (const rel of listEvidenceFiles(root)) {
    const content = fs.readFileSync(path.join(root, EVIDENCE_DIR, rel));
    files[rel] = storeBlob(root, content);
  }
  const claims = readWorkspaceClaims(root);
  validateClaims(claims, files);
  const parent = readHead(root);
  const parentVersion = loadVersion(root, parent);
  const patch = computePatch(parentVersion.files, files, parentVersion.claims, claims);
  const version = {
    parent,
    files,
    claims,
    patch,
    message: message || '',
    time: new Date().toISOString(),
  };
  const hash = storeVersion(root, version);
  writeHead(root, hash);
  return hash;
}

function chainTo(root, targetHash) {
  const chain = [];
  let hash = targetHash;
  const seen = new Set();
  while (hash !== null && hash !== undefined) {
    if (seen.has(hash)) throw new EvchainError(ERR.CORRUPT_VERSION, `cycle at ${hash}`);
    seen.add(hash);
    const version = loadVersion(root, hash);
    chain.unshift({ hash, version });
    hash = version.parent;
  }
  if (chain.length === 0 || chain[0].version.parent !== null) {
    throw new EvchainError(ERR.CORRUPT_VERSION, 'chain does not reach genesis');
  }
  return chain;
}

function verify(root, targetHash) {
  if (!isRepo(root)) throw new EvchainError(ERR.NOT_A_REPO, 'not an evchain repository');
  if (!fs.existsSync(repoPath(root, 'versions', targetHash + '.json'))) {
    throw new EvchainError(ERR.UNKNOWN_VERSION, `unknown version: ${targetHash}`);
  }
  const chain = chainTo(root, targetHash);
  let files = {};
  let claims = [];
  for (const { hash, version } of chain) {
    if (version.parent === null) {
      if (version.patch !== null) {
        throw new EvchainError(ERR.CORRUPT_VERSION, `genesis ${hash} carries a patch`);
      }
      files = { ...version.files };
      claims = version.claims.slice();
    } else {
      const rebuilt = applyPatch(files, claims, version.patch);
      if (!deepEqual(rebuilt.files, version.files)) {
        throw new EvchainError(ERR.PATCH_MISMATCH, `patch does not reproduce manifest at ${hash}`);
      }
      if (!deepEqual(rebuilt.claims, version.claims)) {
        throw new EvchainError(ERR.PATCH_MISMATCH, `patch does not reproduce claims at ${hash}`);
      }
      files = rebuilt.files;
      claims = rebuilt.claims;
    }
    for (const [p, h] of Object.entries(files)) {
      const blob = repoPath(root, 'objects', h);
      if (!fs.existsSync(blob)) {
        throw new EvchainError(ERR.MISSING_EVIDENCE, `evidence blob missing for ${p} (${h}) at ${hash}`);
      }
      if (hashFile(blob) !== h) {
        throw new EvchainError(ERR.HASH_MISMATCH, `evidence blob tampered for ${p} (${h}) at ${hash}`);
      }
    }
    validateClaims(claims, files);
  }
  const head = chain[chain.length - 1];
  const certificate = {
    version: targetHash,
    contentHash: head.hash,
    parentHash: head.version.parent,
    manifestHash: sha256(canonical(files)),
    versions: chain.length,
    verifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(repoPath(root, 'certs', targetHash + '.json'), canonical(certificate));
  return { certificate, files, claims };
}

function checkout(root, targetHash, destDir) {
  const dest = destDir || path.join(root, CHECKOUT_DIR);
  const { files, claims, certificate } = verify(root, targetHash);
  const tmp = dest + '.tmp.' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const [rel, h] of Object.entries(files)) {
    const target = path.join(tmp, EVIDENCE_DIR, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(repoPath(root, 'objects', h), target);
  }
  fs.writeFileSync(path.join(tmp, CLAIMS_FILE), JSON.stringify(claims, null, 2) + '\n');
  fs.writeFileSync(
    path.join(tmp, 'MANIFEST.json'),
    canonical({ version: targetHash, certificate, files }) + '\n'
  );
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return { dir: dest, files, certificate };
}

module.exports = {
  REPO_DIR,
  EVIDENCE_DIR,
  CLAIMS_FILE,
  CHECKOUT_DIR,
  EvchainError,
  ERR,
  sha256,
  canonical,
  initRepo,
  commit,
  verify,
  checkout,
  loadVersion,
  readHead,
  isRepo,
  repoPath,
};
