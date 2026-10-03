import { sha256, canonical, hashRecord, merkleRoot, merkleProof, verifyMerkle } from './hash.js';
import { GenealogyError, E_CYCLE, E_TIME, E_PROOF } from './errors.js';
import { PhraseIndex } from './phrase-index.js';

function emptyState() {
  return { nodes: new Map() };
}

function ensureNode(state, id) {
  if (!state.nodes.has(id)) {
    state.nodes.set(id, { id, note: '', deleted: false, parents: new Set(), children: new Set() });
  }
  return state.nodes.get(id);
}

function reachesViaParents(state, from, target) {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = state.nodes.get(current);
    if (node) for (const parent of node.parents) stack.push(parent);
  }
  return false;
}

function addEdge(state, child, parent) {
  if (child === parent) {
    throw new GenealogyError(E_CYCLE, `self edge on batch ${child}`);
  }
  const childNode = ensureNode(state, child);
  const parentNode = ensureNode(state, parent);
  if (reachesViaParents(state, parent, child)) {
    throw new GenealogyError(E_CYCLE, `edge ${child} <- ${parent} would create a cycle`);
  }
  childNode.parents.add(parent);
  parentNode.children.add(child);
}

function removeEdge(state, child, parent) {
  state.nodes.get(child)?.parents.delete(parent);
  state.nodes.get(parent)?.children.delete(child);
}

function applyRecord(state, record) {
  switch (record.type) {
    case 'add': {
      const node = ensureNode(state, record.id);
      node.note = record.note ?? '';
      node.deleted = false;
      break;
    }
    case 'edge':
      addEdge(state, record.child, record.parent);
      break;
    case 'correct':
      removeEdge(state, record.child, record.oldParent);
      addEdge(state, record.child, record.newParent);
      break;
    case 'delete':
      ensureNode(state, record.id).deleted = true;
      break;
    default:
      throw new GenealogyError(E_PROOF, `unknown record type ${record.type}`);
  }
}

export function makeCorrection(child, oldParent, newParent, ts) {
  return {
    type: 'correct',
    child,
    oldParent,
    newParent,
    ts,
    compensation: [
      { op: 'revoke', child, parent: oldParent },
      { op: 'add', child, parent: newParent },
    ],
  };
}

export class Genealogy {
  #records = [];

  get records() {
    return this.#records.slice();
  }

  get lastTs() {
    return this.#records.length === 0 ? 0 : this.#records[this.#records.length - 1].ts;
  }

  append(record) {
    if (typeof record.ts !== 'number' || record.ts < this.lastTs) {
      throw new GenealogyError(
        E_TIME,
        `record ts ${record.ts} is out of order (last ts ${this.lastTs})`
      );
    }
    const state = this.stateAt(Infinity);
    applyRecord(state, record);
    this.#records.push(record);
    return record;
  }

  stateAt(T = Infinity) {
    const state = emptyState();
    for (const record of this.#records) {
      if (record.ts > T) break;
      applyRecord(state, record);
    }
    return state;
  }

  maskedSet(state) {
    const masked = new Set();
    const stack = [];
    for (const [id, node] of state.nodes) {
      if (node.deleted) {
        masked.add(id);
        stack.push(id);
      }
    }
    while (stack.length > 0) {
      const current = stack.pop();
      const node = state.nodes.get(current);
      if (!node) continue;
      for (const child of node.children) {
        if (!masked.has(child)) {
          masked.add(child);
          stack.push(child);
        }
      }
    }
    return masked;
  }

  #walk(id, T, direction) {
    const state = this.stateAt(T);
    const masked = this.maskedSet(state);
    const node = state.nodes.get(id);
    if (!node) return { masked: false, results: [] };
    if (masked.has(id)) return { masked: true, results: [] };
    const found = new Set();
    const stack = [...node[direction]];
    while (stack.length > 0) {
      const current = stack.pop();
      if (found.has(current)) continue;
      found.add(current);
      const next = state.nodes.get(current);
      if (next) for (const n of next[direction]) stack.push(n);
    }
    return { masked: false, results: [...found].filter((x) => !masked.has(x)).sort() };
  }

  ancestors(id, T = Infinity) {
    return this.#walk(id, T, 'parents');
  }

  descendants(id, T = Infinity) {
    return this.#walk(id, T, 'children');
  }

  search({ phrase, near, distance = 3 } = {}, T = Infinity) {
    const state = this.stateAt(T);
    const index = PhraseIndex.fromState(state, this.maskedSet(state));
    if (phrase !== undefined) return index.phrase(phrase);
    if (near !== undefined) return index.near(near, distance);
    return [];
  }

  certificate(id, T = Infinity) {
    const state = this.stateAt(T);
    const memo = new Map();
    const hashOf = (nid) => {
      if (memo.has(nid)) return memo.get(nid);
      const node = state.nodes.get(nid);
      const parents = node ? [...node.parents].sort() : [];
      const cert = {
        id: nid,
        textHash: sha256(node ? node.note : ''),
        parentHash: sha256(parents.map(hashOf).join(',')),
        tombstone: node && node.deleted ? 1 : 0,
      };
      const hash = sha256(canonical(cert));
      memo.set(nid, hash);
      return hash;
    };
    const node = state.nodes.get(id);
    const parents = node ? [...node.parents].sort() : [];
    const cert = {
      id,
      textHash: sha256(node ? node.note : ''),
      parentHash: sha256(parents.map(hashOf).join(',')),
      tombstone: node && node.deleted ? 1 : 0,
      parents,
    };
    cert.certHash = sha256(
      canonical({ id: cert.id, textHash: cert.textHash, parentHash: cert.parentHash, tombstone: cert.tombstone })
    );
    return cert;
  }

  verifyCertificate(id, cert, T = Infinity) {
    const expected = this.certificate(id, T);
    if (expected.certHash !== cert.certHash) {
      throw new GenealogyError(E_PROOF, `certificate mismatch for batch ${id}`);
    }
    return true;
  }

  inclusionProof(id) {
    const index = this.#records.findIndex((r) => r.type === 'add' && r.id === id);
    if (index < 0) {
      throw new GenealogyError(E_PROOF, `no add record found for batch ${id}`);
    }
    const leaves = this.#records.map(hashRecord);
    return {
      id,
      recordIndex: index,
      record: this.#records[index],
      recordHash: leaves[index],
      proof: merkleProof(leaves, index),
      root: merkleRoot(leaves),
      certificate: this.certificate(id),
    };
  }

  static verifyInclusion(proof) {
    if (hashRecord(proof.record) !== proof.recordHash) {
      throw new GenealogyError(E_PROOF, 'record hash does not match record content');
    }
    if (!verifyMerkle(proof.recordHash, proof.proof, proof.root)) {
      throw new GenealogyError(E_PROOF, 'merkle inclusion path does not resolve to root');
    }
    const cert = proof.certificate;
    const expected = sha256(
      canonical({ id: cert.id, textHash: cert.textHash, parentHash: cert.parentHash, tombstone: cert.tombstone })
    );
    if (expected !== cert.certHash) {
      throw new GenealogyError(E_PROOF, 'certificate hash mismatch');
    }
    return true;
  }
}
