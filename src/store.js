import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from './canon.js';
import { ProvError } from './errors.js';

export function defaultState() {
  return {
    version: 1,
    dataEpoch: 0,
    execEpoch: -1,
    queryHash: null,
    query: null,
    outputs: {},
    inputIndex: {},
    corrections: [],
  };
}

export function makeProof({ outKey, execEpoch, queryHash, row, provenance, contributions, minimal }) {
  const body = { outKey, execEpoch, queryHash, row, provenance, contributions, minimal };
  return { ...body, digest: sha256(canonical(body)) };
}

export function verifyProof(proof) {
  if (!proof || typeof proof !== 'object' || typeof proof.digest !== 'string') {
    throw new ProvError('E_PROOF', 'proof malformed');
  }
  const { digest, ...body } = proof;
  if (sha256(canonical(body)) !== digest) {
    throw new ProvError('E_PROOF', 'proof digest mismatch: file tampered');
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.provDir = path.join(this.dataDir, '.prov');
    this.statePath = path.join(this.provDir, 'state.json');
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch {
      throw new ProvError('E_KEY', `no provenance state in ${this.dataDir}; run exec first`);
    }
    return JSON.parse(raw);
  }

  loadOrInit() {
    try {
      return this.load();
    } catch (err) {
      if (err instanceof ProvError && err.code === 'E_KEY') return defaultState();
      throw err;
    }
  }

  save(state) {
    fs.mkdirSync(path.join(this.provDir, 'proofs'), { recursive: true });
    fs.mkdirSync(path.join(this.provDir, 'certs'), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  tables() {
    let entries;
    try {
      entries = fs.readdirSync(this.dataDir, { withFileTypes: true });
    } catch {
      throw new ProvError('E_KEY', `data directory not found: ${this.dataDir}`);
    }
    const out = {};
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const name = e.name.slice(0, -'.json'.length);
      out[name] = JSON.parse(fs.readFileSync(path.join(this.dataDir, e.name), 'utf8'));
    }
    return out;
  }

  readTable(name) {
    const p = path.join(this.dataDir, `${name}.json`);
    if (!fs.existsSync(p)) throw new ProvError('E_KEY', `unknown table '${name}'`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  writeTable(name, table) {
    fs.writeFileSync(path.join(this.dataDir, `${name}.json`), JSON.stringify(table, null, 2));
  }

  proofPath(outKey) {
    return path.join(this.provDir, 'proofs', `${sha256(outKey)}.json`);
  }

  certPath(outKey) {
    return path.join(this.provDir, 'certs', `${sha256(outKey)}.json`);
  }

  writeProof(proof) {
    fs.mkdirSync(path.join(this.provDir, 'proofs'), { recursive: true });
    fs.writeFileSync(this.proofPath(proof.outKey), JSON.stringify(proof, null, 2));
  }

  readProof(outKey) {
    let raw;
    try {
      raw = fs.readFileSync(this.proofPath(outKey), 'utf8');
    } catch {
      throw new ProvError('E_PROOF', `proof file missing for '${outKey}'`);
    }
    let proof;
    try {
      proof = JSON.parse(raw);
    } catch {
      throw new ProvError('E_PROOF', `proof file corrupted for '${outKey}'`);
    }
    verifyProof(proof);
    if (proof.outKey !== outKey) throw new ProvError('E_PROOF', 'proof does not match requested outKey');
    return proof;
  }

  writeCert(cert) {
    fs.mkdirSync(path.join(this.provDir, 'certs'), { recursive: true });
    fs.writeFileSync(this.certPath(cert.outKey), JSON.stringify(cert, null, 2));
  }
}

export function applyCorrection(store, tableName, key, patch) {
  const state = store.loadOrInit();
  const table = store.readTable(tableName);
  const keyCol = table.key;
  if (typeof keyCol !== 'string') throw new ProvError('E_KEY', `table '${tableName}' has no key declaration`);
  const row = (table.rows ?? []).find((r) => String(r?.[keyCol]) === String(key));
  if (!row) throw new ProvError('E_KEY', `no row with ${keyCol}='${key}' in table '${tableName}'`);
  const changedColumns = Object.keys(patch).filter((c) => canonical(row[c]) !== canonical(patch[c]));
  Object.assign(row, patch);
  store.writeTable(tableName, table);
  state.dataEpoch += 1;
  state.corrections.push({ epoch: state.dataEpoch, table: tableName, key: String(key), patch, changedColumns });
  store.save(state);
  return { epoch: state.dataEpoch, table: tableName, key: String(key), changedColumns };
}
