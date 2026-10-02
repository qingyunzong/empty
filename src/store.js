import fs from 'node:fs';
import path from 'node:path';
import { hashValue, sha256 } from './canon.js';
import { ProvError, E_KEY, E_PROOF, E_STALE_PROOF, E_PARTIAL_HIDDEN } from './errors.js';
import { execute } from './engine.js';

const norm = (v) => (v === undefined ? null : v);

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, code, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ProvError(code, `missing ${what}: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProvError(code, `corrupt ${what}: ${file}`);
  }
}

export function loadTables(query, dataDir) {
  const names = new Set([query.from, ...(query.joins ?? []).map((j) => j.table)]);
  const tables = new Map();
  for (const name of names) {
    const file = path.join(dataDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      throw new ProvError(E_KEY, `missing data file for table '${name}': ${file}`);
    }
    const parsed = readJson(file, E_KEY, `data file for table '${name}'`);
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    if (!Array.isArray(rows)) throw new ProvError(E_KEY, `table '${name}' has no row array`);
    const key = query.tables?.[name]?.key ?? (Array.isArray(parsed) ? 'id' : (parsed.key ?? 'id'));
    tables.set(name, { key, rows });
  }
  return tables;
}

function splitRid(rid) {
  const i = rid.indexOf(':');
  return [rid.slice(0, i), rid.slice(i + 1)];
}

function findRow(table, keyString) {
  return table.rows.find((r) => String(norm(r[table.key])) === keyString);
}

function buildProof(out, queryHash, generation, tables) {
  const inputDigests = {};
  for (const rid of out.provenance.contributors) {
    const [tableName, keyString] = splitRid(rid);
    const row = findRow(tables.get(tableName), keyString);
    if (!row) throw new ProvError(E_KEY, `contributor '${rid}' not found in current data`);
    inputDigests[rid] = hashValue(row);
  }
  const body = {
    outKey: out.outKey,
    queryHash,
    generation,
    row: out.row,
    provenance: out.provenance,
    inputDigests,
  };
  return { ...body, digest: hashValue(body) };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
  }

  get manifestPath() {
    return path.join(this.dir, 'manifest.json');
  }

  exists() {
    return fs.existsSync(this.manifestPath);
  }

  loadManifest() {
    if (!this.exists()) {
      throw new ProvError(E_PROOF, `no execution state in '${this.dir}'; run exec first`);
    }
    return readJson(this.manifestPath, E_PROOF, 'manifest');
  }

  saveManifest(manifest) {
    writeAtomic(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  fileFor(kind, outKey) {
    return path.join(this.dir, kind, `${sha256(outKey)}.json`);
  }

  exec(query, dataDir) {
    const tables = loadTables(query, dataDir);
    const outputs = execute(query, tables);
    const prior = this.exists() ? this.loadManifest() : null;
    const generation = prior ? prior.generation : 0;
    const corrections = prior ? prior.corrections : [];
    const queryHash = hashValue(query);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const manifest = {
      version: 1,
      queryHash,
      query,
      dataDir: path.resolve(dataDir),
      generation,
      corrections,
      tables: {},
      outputs: [],
      index: {},
    };
    for (const [name, t] of tables) {
      manifest.tables[name] = { key: t.key, rows: t.rows.length, digest: hashValue(t.rows) };
    }
    for (const out of outputs) {
      manifest.outputs.push(out.outKey);
      manifest.index[out.outKey] = out.provenance.contributors;
      writeAtomic(this.fileFor('outputs', out.outKey), JSON.stringify(out, null, 2));
      const proof = buildProof(out, queryHash, generation, tables);
      writeAtomic(this.fileFor('proofs', out.outKey), JSON.stringify(proof, null, 2));
    }
    this.saveManifest(manifest);
    return { outputs, manifest };
  }

  readProofFile(outKey) {
    const file = this.fileFor('proofs', outKey);
    if (!fs.existsSync(file)) throw new ProvError(E_PROOF, `missing proof file for '${outKey}'`);
    const proof = readJson(file, E_PROOF, `proof for '${outKey}'`);
    if (proof.outKey !== outKey) {
      throw new ProvError(E_PROOF, `proof file for '${outKey}' is mismatched`);
    }
    return proof;
  }

  checkDigest(proof) {
    const { digest, ...body } = proof;
    if (hashValue(body) !== digest) {
      throw new ProvError(E_PROOF, `proof digest mismatch for '${proof.outKey}'`);
    }
  }

  prove(outKey) {
    const manifest = this.loadManifest();
    if (!manifest.outputs.includes(outKey)) {
      throw new ProvError(E_KEY, `unknown output key '${outKey}'`);
    }
    const proof = this.readProofFile(outKey);
    this.checkDigest(proof);
    if (proof.queryHash !== manifest.queryHash) {
      throw new ProvError(E_STALE_PROOF, `proof for '${outKey}' was made for a different query`);
    }
    if (proof.generation !== manifest.generation) {
      throw new ProvError(
        E_STALE_PROOF,
        `proof for '${outKey}' is at generation ${proof.generation}, data is at generation ${manifest.generation}; run reverify`,
      );
    }
    return proof;
  }

  correct(tableName, key, patch) {
    const manifest = this.loadManifest();
    const tmeta = manifest.tables[tableName];
    if (!tmeta) throw new ProvError(E_KEY, `unknown table '${tableName}'`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ProvError(E_KEY, 'patch must be a JSON object');
    }
    if (Object.hasOwn(patch, tmeta.key)) {
      throw new ProvError(E_KEY, `patch must not modify key column '${tmeta.key}'`);
    }
    const file = path.join(manifest.dataDir, `${tableName}.json`);
    const parsed = readJson(file, E_KEY, `data file for table '${tableName}'`);
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    const row = rows.find((r) => String(norm(r[tmeta.key])) === String(key) && norm(r[tmeta.key]) !== null);
    if (!row) throw new ProvError(E_KEY, `no row with key '${key}' in table '${tableName}'`);
    Object.assign(row, patch);
    writeAtomic(file, JSON.stringify(Array.isArray(parsed) ? rows : parsed, null, 2));
    const rid = `${tableName}:${key}`;
    const affected = manifest.outputs.filter((ok) => manifest.index[ok].includes(rid));
    manifest.generation += 1;
    manifest.corrections.push({ generation: manifest.generation, table: tableName, key, patch, affected });
    manifest.tables[tableName].digest = hashValue(rows);
    this.saveManifest(manifest);
    return {
      rid,
      generation: manifest.generation,
      affected,
      unaffected: manifest.outputs.length - affected.length,
    };
  }

  reverify(outKey) {
    const manifest = this.loadManifest();
    if (!manifest.outputs.includes(outKey)) {
      throw new ProvError(E_KEY, `unknown output key '${outKey}'`);
    }
    const proof = this.readProofFile(outKey);
    this.checkDigest(proof);
    if (proof.queryHash !== manifest.queryHash) {
      throw new ProvError(E_STALE_PROOF, `proof for '${outKey}' was made for a different query; run exec`);
    }
    const tables = loadTables(manifest.query, manifest.dataDir);
    const outputs = execute(manifest.query, tables);
    const current = outputs.find((o) => o.outKey === outKey);
    const corrections = manifest.corrections
      .filter((c) => c.affected.includes(outKey))
      .map((c) => ({ generation: c.generation, table: c.table, key: c.key }));
    let certificate;
    if (!current) {
      certificate = {
        outKey,
        status: 'affected',
        reason: 'output-vanished',
        generation: manifest.generation,
        corrections,
      };
    } else {
      const changed =
        hashValue({ row: current.row, provenance: current.provenance }) !==
        hashValue({ row: proof.row, provenance: proof.provenance });
      const fresh = buildProof(current, manifest.queryHash, manifest.generation, tables);
      writeAtomic(this.fileFor('proofs', outKey), JSON.stringify(fresh, null, 2));
      writeAtomic(this.fileFor('outputs', outKey), JSON.stringify(current, null, 2));
      manifest.index[outKey] = current.provenance.contributors;
      certificate = {
        outKey,
        status: changed ? 'affected' : 'unaffected',
        generation: manifest.generation,
        partial: current.provenance.partial,
        unknowns: current.provenance.unknowns,
        contributors: current.provenance.contributors,
        minimal: current.provenance.minimal,
        corrections,
      };
      if (changed) {
        certificate.previousRow = proof.row;
        certificate.row = current.row;
      }
    }
    writeAtomic(this.fileFor('certificates', outKey), JSON.stringify(certificate, null, 2));
    this.saveManifest(manifest);
    return certificate;
  }

  reverifyAll() {
    const manifest = this.loadManifest();
    const partials = [];
    for (const outKey of manifest.outputs) {
      const out = readJson(this.fileFor('outputs', outKey), E_PROOF, `output '${outKey}'`);
      if (out.provenance.partial) partials.push(outKey);
    }
    if (partials.length > 0) {
      throw new ProvError(
        E_PARTIAL_HIDDEN,
        `refusing blanket certificate: ${partials.length} output(s) carry partial provenance; reverify them individually`,
        { partials },
      );
    }
    const certificates = manifest.outputs.map((ok) => this.reverify(ok));
    const summary = {
      generation: this.loadManifest().generation,
      total: certificates.length,
      affected: certificates.filter((c) => c.status === 'affected').map((c) => c.outKey),
      unaffected: certificates.filter((c) => c.status === 'unaffected').map((c) => c.outKey),
    };
    writeAtomic(path.join(this.dir, 'certificates', '_summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }

  explain(outKey) {
    const manifest = this.loadManifest();
    if (outKey === undefined) {
      return {
        query: manifest.query,
        dataDir: manifest.dataDir,
        generation: manifest.generation,
        tables: manifest.tables,
        outputs: manifest.outputs.length,
        corrections: manifest.corrections,
      };
    }
    if (!manifest.outputs.includes(outKey)) {
      throw new ProvError(E_KEY, `unknown output key '${outKey}'`);
    }
    const out = readJson(this.fileFor('outputs', outKey), E_PROOF, `output '${outKey}'`);
    const byTable = {};
    for (const rid of out.provenance.contributors) {
      const [t] = splitRid(rid);
      (byTable[t] ??= []).push(rid);
    }
    const certFile = this.fileFor('certificates', outKey);
    return {
      outKey,
      row: out.row,
      provenance: out.provenance,
      byTable,
      corrections: manifest.corrections.filter((c) => c.affected.includes(outKey)),
      certificate: fs.existsSync(certFile) ? readJson(certFile, E_PROOF, `certificate '${outKey}'`) : null,
    };
  }
}
