import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export class ConflictError extends Error {
  constructor(certificate) {
    super('E_CONFLICT');
    this.name = 'ConflictError';
    this.code = 'E_CONFLICT';
    this.certificate = certificate;
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.versions = new Map();
    this._load();
  }

  static init(dir) {
    fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    return new Store(dir);
  }

  _load() {
    const objDir = path.join(this.dir, 'objects');
    if (!fs.existsSync(objDir)) return;
    for (const f of fs.readdirSync(objDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(objDir, f), 'utf8'));
      this.versions.set(meta.hash, meta);
    }
  }

  getBuffer(hash) {
    return fs.readFileSync(path.join(this.dir, 'objects', `${hash}.bin`));
  }

  ancestorsOf(hash) {
    const seen = new Set();
    const stack = [hash];
    while (stack.length) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      const meta = this.versions.get(h);
      if (meta?.parent) stack.push(meta.parent);
    }
    return seen;
  }

  descendantsOf(base) {
    const result = [];
    for (const meta of this.versions.values()) {
      if (meta.hash === base) continue;
      if (this.ancestorsOf(meta.hash).has(base)) result.push(meta);
    }
    return result;
  }

  _depthsFrom(hash) {
    const depth = new Map([[hash, 0]]);
    const queue = [hash];
    while (queue.length) {
      const h = queue.shift();
      const parent = this.versions.get(h)?.parent;
      if (parent && !depth.has(parent)) {
        depth.set(parent, depth.get(h) + 1);
        queue.push(parent);
      }
    }
    return depth;
  }

  commonAncestor(a, b) {
    const da = this._depthsFrom(a);
    const db = this._depthsFrom(b);
    let best = null;
    for (const [h, d1] of da) {
      if (!db.has(h)) continue;
      const score = d1 + db.get(h);
      if (!best || score < best.score || (score === best.score && h < best.hash)) {
        best = { hash: h, score };
      }
    }
    return best ? best.hash : null;
  }

  commit({ base = null, readSet = [], writeSet = [], buffer }) {
    const sortedReads = [...readSet].sort();
    const sortedWrites = [...writeSet].sort();
    if (base !== null && !this.versions.has(base)) {
      const err = new Error(`E_UNKNOWN_BASE: ${base}`);
      err.code = 'E_UNKNOWN_BASE';
      throw err;
    }
    if (base !== null) {
      const descendants = this.descendantsOf(base).sort((x, y) => (x.hash < y.hash ? -1 : 1));
      for (const v of descendants) {
        const overlap = sortedReads.filter((n) => v.writeSet.includes(n));
        if (overlap.length > 0) {
          throw new ConflictError({
            error: 'E_CONFLICT',
            baseHash: base,
            theirHash: v.hash,
            readSet: sortedReads,
            conflictingNodes: overlap,
            commonAncestor: this.commonAncestor(base, v.hash),
          });
        }
      }
    }
    const contentHash = sha256hex(buffer);
    const hash = sha256hex(JSON.stringify([base, contentHash, sortedWrites]));
    const meta = { hash, parent: base, readSet: sortedReads, writeSet: sortedWrites, contentHash };
    fs.writeFileSync(path.join(this.dir, 'objects', `${hash}.bin`), buffer);
    fs.writeFileSync(path.join(this.dir, 'objects', `${hash}.json`), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(this.dir, 'refs', 'HEAD'), hash);
    this.versions.set(hash, meta);
    return meta;
  }
}
