import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PositionalIndex } from './index.js';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class BondTree {
  // file 为 null 时纯内存运行；否则从文件加载并在每次变更后落盘。
  constructor(file = null) {
    this.file = file;
    this.nodes = new Map(); // id -> node
    this.index = new PositionalIndex();
    this.certHead = null;   // 根证书哈希（哈希链头）
    this.seq = 0;
    if (file && fs.existsSync(file)) this.#load();
  }

  #load() {
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const n of data.nodes) this.nodes.set(n.id, n);
    this.index = PositionalIndex.deserialize(data.index);
    this.certHead = data.certHead ?? null;
    this.seq = data.seq ?? 0;
  }

  #save() {
    if (!this.file) return;
    const data = {
      nodes: [...this.nodes.values()],
      index: this.index.serialize(),
      certHead: this.certHead,
      seq: this.seq,
    };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file) || '.', { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  getNode(id) {
    return this.nodes.get(id) ?? null;
  }

  listNodes() {
    return [...this.nodes.values()];
  }

  childrenOf(id) {
    return this.listNodes().filter((n) => n.parentId === id);
  }

  addNode({ id, parentId = null, faceValue = 0, lineLimit = 0, terms = '', state = 'active' }) {
    if (!id) throw new Error('id is required');
    if (this.nodes.has(id)) throw new Error(`node already exists: ${id}`);
    if (parentId !== null && !this.nodes.has(parentId)) {
      throw new Error(`parent not found: ${parentId}`);
    }
    const node = {
      id, parentId,
      faceValue: Number(faceValue),
      lineLimit: Number(lineLimit), // <=0 表示不限额
      terms: String(terms),
      state,
      occupied: 0,     // 缓存：子树实际占用
      allocOwn: 0,     // 本节点直接分配累计
      releasedOwn: 0,  // 本节点直接释放累计
    };
    this.nodes.set(id, node);
    this.index.addDocument(id, node.terms);
    this.#save();
    return node;
  }

  #pathToRoot(id) {
    const path = [];
    let cur = this.nodes.get(id);
    while (cur) {
      path.push(cur);
      cur = cur.parentId === null ? null : this.nodes.get(cur.parentId);
    }
    return path;
  }

  // 占用：自节点向上每层 +amount；任一层超出 lineLimit 则整树不变。
  allocate(id, amount) {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, error: `node not found: ${id}` };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'amount must be a positive integer' };
    const path = this.#pathToRoot(id);
    for (const n of path) {
      if (n.lineLimit > 0 && n.occupied + amount > n.lineLimit) {
        return { ok: false, error: `line limit exceeded at level ${n.id}` };
      }
    }
    for (const n of path) n.occupied += amount;
    node.allocOwn += amount;
    this.#save();
    return { ok: true };
  }

  // 撤销补偿：自节点向上逐层释放 amount。
  // 每层释放不得超过该层实际占用；任一层额度不足则全部层不变（原子）。
  // 证书包含每层释放前/后占用、命中位置与根证书哈希。
  revoke(id, amount, hits = []) {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, error: `node not found: ${id}` };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'amount must be a positive integer' };
    const path = this.#pathToRoot(id);
    for (const n of path) {
      if (n.occupied < amount) {
        return { ok: false, error: `insufficient occupancy at level ${n.id}: ${n.occupied} < ${amount}` };
      }
    }
    const levels = path.map((n) => {
      const before = n.occupied;
      n.occupied -= amount;
      return { id: n.id, before, after: n.occupied };
    });
    node.releasedOwn += amount;
    if (node.occupied === 0 && node.state === 'active') node.state = 'revoked';

    this.seq += 1;
    const cert = {
      seq: this.seq,
      prev: this.certHead,
      nodeId: id,
      amount,
      levels,
      hits,
    };
    cert.hash = sha256(JSON.stringify(cert));
    this.certHead = cert.hash;
    this.#save();
    return { ok: true, certificate: cert };
  }

  rootCertHash() {
    return this.certHead;
  }

  // 独立校验：由 allocOwn/releasedOwn 后序遍历重算每层占用
  postOrderOccupied() {
    const result = new Map();
    const visit = (id) => {
      const node = this.nodes.get(id);
      let sum = node.allocOwn - node.releasedOwn;
      for (const c of this.childrenOf(id)) sum += visit(c.id);
      result.set(id, sum);
      return sum;
    };
    for (const n of this.nodes.values()) if (n.parentId === null) visit(n.id);
    return result;
  }

  findByPhrase(text) {
    return this.index.phrase(text);
  }

  findNear(text, k) {
    return this.index.near(text, k);
  }

  // 近邻检索定位条款相关节点，逐个撤销并汇总证书
  revokeByNear(text, k, amount) {
    const matches = this.findNear(text, k);
    const certificates = [];
    for (const [docId, hits] of matches) {
      const r = this.revoke(docId, amount, hits);
      if (!r.ok) return { ok: false, error: r.error, certificates };
      certificates.push(r.certificate);
    }
    return { ok: true, certificates };
  }

  // 物理删除：有存活（active）子节点时失败；否则级联移除本子树中非存活节点，
  // 并增量移除索引位置。
  deleteNode(id) {
    if (!this.nodes.has(id)) return { ok: false, error: `node not found: ${id}` };
    const blocked = (nid) =>
      this.childrenOf(nid).some((c) => c.state === 'active' || blocked(c.id));
    if (blocked(id)) return { ok: false, error: `node has live children: ${id}` };

    const removed = [];
    const collect = (nid) => {
      removed.push(nid);
      for (const c of this.childrenOf(nid)) collect(c.id);
    };
    collect(id);
    for (const nid of removed) {
      this.nodes.delete(nid);
      this.index.removeDocument(nid);
    }
    this.#save();
    return { ok: true, removed };
  }
}
