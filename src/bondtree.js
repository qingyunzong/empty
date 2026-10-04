import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PositionalIndex, tokenize } from './posindex.js';

export class InsufficientOccupancyError extends Error {
  constructor(nodeId, required, available) {
    super(`insufficient occupancy at ${nodeId}: required ${required}, available ${available}`);
    this.name = 'InsufficientOccupancyError';
    this.nodeId = nodeId;
    this.required = required;
    this.available = available;
  }
}

export class HasLiveChildrenError extends Error {
  constructor(nodeId, children) {
    super(`node ${nodeId} has live children: ${children.join(', ')}`);
    this.name = 'HasLiveChildrenError';
    this.children = children;
  }
}

const ZERO_HASH = '0'.repeat(64);

function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export class BondTree {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.nodes = new Map();
    this.index = new PositionalIndex();
    this.certs = [];
    this.certTip = ZERO_HASH;
    if (fs.existsSync(this.statePath)) this.#load();
  }

  #load() {
    const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    for (const node of data.nodes) this.nodes.set(node.id, node);
    this.index = PositionalIndex.deserialize(data.index);
    this.certs = data.certs;
    this.certTip = data.certTip;
  }

  save() {
    const data = {
      nodes: [...this.nodes.values()],
      index: this.index.serialize(),
      certs: this.certs,
      certTip: this.certTip,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
  }

  getNode(id) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node: ${id}`);
    return node;
  }

  childrenOf(id) {
    return [...this.nodes.values()].filter((n) => n.parentId === id);
  }

  // Ancestors from the node's parent up to the root, closest first.
  #ancestorPath(node) {
    const pathUp = [];
    let cur = node.parentId;
    while (cur !== null && cur !== undefined) {
      const ancestor = this.getNode(cur);
      pathUp.push(ancestor);
      cur = ancestor.parentId;
    }
    return pathUp;
  }

  addNode({ id, parentId = null, faceValue = 0, lineLimit = 0, terms = '', state = 'active' }) {
    if (this.nodes.has(id)) throw new Error(`duplicate node: ${id}`);
    if (faceValue < 0) throw new Error('faceValue must be non-negative');
    const node = { id, parentId, faceValue, lineLimit, terms, state, occupied: 0 };
    if (parentId !== null) {
      this.getNode(parentId);
      if (state === 'active' && faceValue > 0) {
        const pathUp = this.#ancestorPath(node);
        for (const ancestor of pathUp) {
          if (ancestor.occupied + faceValue > ancestor.lineLimit) {
            throw new InsufficientOccupancyError(
              ancestor.id, ancestor.occupied + faceValue, ancestor.lineLimit);
          }
        }
        for (const ancestor of pathUp) ancestor.occupied += faceValue;
      }
    }
    this.nodes.set(id, node);
    this.index.addDocument(id, terms);
    this.save();
    return node;
  }

  // Check-then-apply release of `amount` along the ancestor chain.
  // If any level cannot cover the release, nothing is mutated.
  #releaseChain(node, amount) {
    const pathUp = this.#ancestorPath(node);
    const levels = [];
    for (const ancestor of pathUp) {
      if (ancestor.occupied < amount) {
        throw new InsufficientOccupancyError(ancestor.id, amount, ancestor.occupied);
      }
      levels.push({ nodeId: ancestor.id, before: ancestor.occupied, after: ancestor.occupied - amount });
    }
    for (const ancestor of pathUp) ancestor.occupied -= amount;
    return levels;
  }

  revokeNode(id) {
    const node = this.getNode(id);
    if (node.state !== 'active') {
      throw new Error(`node ${id} is not active (state=${node.state})`);
    }
    const amount = node.faceValue;
    // Atomic: #releaseChain validates every level before mutating any.
    const levels = this.#releaseChain(node, amount);
    node.state = 'revoked';
    // Locate term-related nodes via proximity search for the certificate.
    const terms = [...new Set(tokenize(node.terms))];
    const hits = terms.length > 0
      ? this.index.near(terms.join(' '), terms.length + 2)
      : [];
    const certBody = {
      seq: this.certs.length,
      type: 'revoke',
      nodeId: id,
      amount,
      levels,
      hits,
      prevHash: this.certTip,
    };
    const cert = { ...certBody, hash: sha256hex(JSON.stringify(certBody)) };
    this.certs.push(cert);
    this.certTip = cert.hash;
    this.save();
    return cert;
  }

  deleteNode(id) {
    const node = this.getNode(id);
    const liveChildren = this.childrenOf(id).map((c) => c.id);
    if (liveChildren.length > 0) throw new HasLiveChildrenError(id, liveChildren);
    if (node.state === 'active' && node.faceValue > 0) {
      this.#releaseChain(node, node.faceValue);
    }
    this.index.removeDocument(id);
    this.nodes.delete(id);
    this.save();
    return { deleted: id };
  }

  // Independent post-order recomputation of occupancy: sum of faceValue
  // over all active descendants. Does not read the stored `occupied`.
  postOrderOccupancy(id) {
    this.getNode(id);
    const children = new Map();
    for (const n of this.nodes.values()) {
      if (n.parentId !== null) {
        if (!children.has(n.parentId)) children.set(n.parentId, []);
        children.get(n.parentId).push(n.id);
      }
    }
    let total = 0;
    const stack = [[id, false]];
    while (stack.length > 0) {
      const [cur, expanded] = stack.pop();
      if (!expanded) {
        stack.push([cur, true]);
        for (const child of children.get(cur) ?? []) stack.push([child, false]);
      } else if (cur !== id) {
        const node = this.nodes.get(cur);
        if (node.state === 'active') total += node.faceValue;
      }
    }
    return total;
  }

  phrase(query) {
    return this.index.phrase(query);
  }

  near(query, k = 5) {
    return this.index.near(query, k);
  }

  verifyCertChain() {
    let prev = ZERO_HASH;
    for (const cert of this.certs) {
      if (cert.prevHash !== prev) return false;
      const { hash, ...body } = cert;
      if (sha256hex(JSON.stringify(body)) !== hash) return false;
      prev = hash;
    }
    return prev === this.certTip;
  }
}
