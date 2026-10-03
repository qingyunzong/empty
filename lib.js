'use strict';

const crypto = require('node:crypto');

const EXIT_INPUT_ERROR = 11;

class TraceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TraceError';
    this.exitCode = EXIT_INPUT_ERROR;
  }
}

function edgeKey(from, to) {
  return from + '→' + to;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 事件 DAG 追溯库。
 *
 * 正向编译：节点即 NFA 状态，边即迁移（携带版本号），markBad 的节点为初始
 * 状态集合；影响锥（cone）= 从初始集合正向可达的状态集，用支持计数
 * （in-cone 父节点数）增量维护。反向邻接表同步维护，供召回查询做反向
 * 可达（祖先）遍历。
 */
class TraceStore {
  constructor() {
    this.nodes = new Set();
    this.edges = new Map(); // edgeKey -> { from, to, ver }
    this.out = new Map();   // node -> Set<node> 正向迁移
    this.inn = new Map();   // node -> Set<node> 反向迁移（同步维护）
    this.bad = new Set();   // 污染源（NFA 初始状态）
    this.support = new Map(); // node -> 处于影响锥内的父节点数
    this.cone = new Set();  // 影响锥：自污染源正向可达的节点
  }

  _ensureNode(node) {
    if (!this.nodes.has(node)) {
      this.nodes.add(node);
      this.out.set(node, new Set());
      this.inn.set(node, new Set());
      this.support.set(node, 0);
    }
  }

  _requireNode(node, what) {
    if (!this.nodes.has(node)) {
      throw new TraceError(`${what}: unknown node ${JSON.stringify(node)}`);
    }
  }

  /** 正向 BFS（全图），用于成环检测。 */
  reachableFrom(start) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const u = queue.shift();
      for (const v of this.out.get(u)) {
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      }
    }
    return seen;
  }

  addEdge(from, to, ver) {
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new TraceError('edge: from/to must be strings');
    }
    if (!Number.isInteger(ver) || ver < 0) {
      throw new TraceError(`edge ${from}→${to}: ver must be a non-negative integer`);
    }
    this._ensureNode(from);
    this._ensureNode(to);
    const key = edgeKey(from, to);
    const existing = this.edges.get(key);
    if (existing) {
      if (ver < existing.ver) {
        throw new TraceError(`edge ${key}: version rollback ${existing.ver} -> ${ver}`);
      }
      existing.ver = ver; // 同边版本升级，结构不变
      return { changed: false };
    }
    if (from === to) {
      throw new TraceError(`edge ${key}: self-loop creates a cycle`);
    }
    if (this.reachableFrom(to).has(from)) {
      throw new TraceError(`edge ${key}: creates a cycle`);
    }
    this.edges.set(key, { from, to, ver });
    this.out.get(from).add(to);
    this.inn.get(to).add(from);
    // 增量扩散：仅当父端在锥内才影响子端支持计数
    if (this.cone.has(from)) {
      this.support.set(to, this.support.get(to) + 1);
      if (!this.cone.has(to)) this._enterCone(to);
    }
    return { changed: true };
  }

  delEdge(from, to) {
    const key = edgeKey(from, to);
    if (!this.edges.has(key)) {
      throw new TraceError(`delEdge ${key}: edge does not exist`);
    }
    this.edges.delete(key);
    this.out.get(from).delete(to);
    this.inn.get(to).delete(from);
    // 增量回收：支持计数归零且非污染源才移出锥；多父节点其余支持保留
    if (this.cone.has(from)) {
      this.support.set(to, this.support.get(to) - 1);
      if (this.support.get(to) === 0 && !this.bad.has(to) && this.cone.has(to)) {
        this._exitCone(to);
      }
    }
    return { changed: true };
  }

  _enterCone(node) {
    this.cone.add(node);
    for (const child of this.out.get(node)) {
      this.support.set(child, this.support.get(child) + 1);
      if (!this.cone.has(child)) this._enterCone(child);
    }
  }

  _exitCone(node) {
    this.cone.delete(node);
    for (const child of this.out.get(node)) {
      this.support.set(child, this.support.get(child) - 1);
      if (this.support.get(child) === 0 && !this.bad.has(child) && this.cone.has(child)) {
        this._exitCone(child);
      }
    }
  }

  markBad(node) {
    this._requireNode(node, 'markBad');
    if (this.bad.has(node)) return { changed: false };
    this.bad.add(node);
    if (!this.cone.has(node)) this._enterCone(node);
    return { changed: true };
  }

  /** 反向 BFS：query 节点的祖先集（含自身）。 */
  ancestorsOf(node) {
    const seen = new Set([node]);
    const queue = [node];
    while (queue.length > 0) {
      const u = queue.shift();
      for (const p of this.inn.get(u)) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return seen;
  }

  /** 在 allowed 集合内从 sources 之一到 target 的 BFS 路径（节点序列）。 */
  _bfsPath(sources, target, allowed) {
    const prev = new Map();
    const queue = [];
    for (const s of sources) {
      if (allowed.has(s) && !prev.has(s)) {
        prev.set(s, null);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const u = queue.shift();
      if (u === target) {
        const path = [];
        let cur = u;
        while (cur !== null) {
          path.push(cur);
          cur = prev.get(cur);
        }
        return path.reverse();
      }
      for (const v of this.out.get(u)) {
        if (allowed.has(v) && !prev.has(v)) {
          prev.set(v, u);
          queue.push(v);
        }
      }
    }
    return null;
  }

  _certificateFor(batch, target, ancestors) {
    const upstream = this._bfsPath([...this.bad].sort(), batch, this.cone);
    const downstream = this._bfsPath([batch], target, ancestors);
    const path = upstream.concat(downstream.slice(1));
    const edges = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const e = this.edges.get(edgeKey(path[i], path[i + 1]));
      edges.push({ from: e.from, to: e.to, ver: e.ver });
    }
    return { batch, path, edges };
  }

  /**
   * 召回查询：受影响批次 = 影响锥 ∩ query 的反向可达祖先集。
   * 返回 affected[]、证书（路径 + 边版本 + 查询哈希）与 coneSize。
   */
  query(node) {
    this._requireNode(node, 'query');
    const ancestors = this.ancestorsOf(node);
    const affected = [...this.cone].filter((n) => ancestors.has(n)).sort();
    const items = affected.map((b) => this._certificateFor(b, node, ancestors));
    const queryHash = sha256(stableStringify({
      query: node,
      affected,
      bad: [...this.bad].sort(),
    }));
    const cert = { query: node, queryHash, items };
    return { affected, cert, coneSize: this.cone.size };
  }

  /**
   * 离线重放验证证书：逐条核对路径连通性、边存在且版本一致、
   * 路径起点为污染源、终点为 query 节点，并重算查询哈希比对。
   */
  verifyCert(cert) {
    const errors = [];
    const affected = [];
    for (const item of cert.items) {
      const { batch, path, edges } = item;
      let ok = true;
      if (!Array.isArray(path) || path.length === 0 || path.length !== edges.length + 1) {
        errors.push(`batch ${batch}: malformed path`);
        continue;
      }
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.from !== path[i] || e.to !== path[i + 1]) {
          errors.push(`batch ${batch}: edge ${i} does not match path`);
          ok = false;
          break;
        }
        const cur = this.edges.get(edgeKey(e.from, e.to));
        if (!cur) {
          errors.push(`batch ${batch}: edge ${e.from}→${e.to} missing in store`);
          ok = false;
          break;
        }
        if (cur.ver !== e.ver) {
          errors.push(`batch ${batch}: edge ${e.from}→${e.to} version ${e.ver} != current ${cur.ver}`);
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!this.bad.has(path[0])) {
        errors.push(`batch ${batch}: path does not start at a bad node`);
        continue;
      }
      if (path[path.length - 1] !== cert.query) {
        errors.push(`batch ${batch}: path does not end at query node`);
        continue;
      }
      if (!path.includes(batch)) {
        errors.push(`batch ${batch}: batch not on its own evidence path`);
        continue;
      }
      affected.push(batch);
    }
    affected.sort();
    const queryHash = sha256(stableStringify({
      query: cert.query,
      affected,
      bad: [...this.bad].sort(),
    }));
    if (queryHash !== cert.queryHash) {
      errors.push('queryHash mismatch');
    }
    return { ok: errors.length === 0, errors, affected, queryHash };
  }

  /** 当前库状态哈希（边 + 版本 + 污染源），用于幂等/审计比对。 */
  stateHash() {
    const edges = [...this.edges.values()]
      .map((e) => [e.from, e.to, e.ver])
      .sort();
    return sha256(stableStringify({ edges, bad: [...this.bad].sort() }));
  }
}

module.exports = { TraceStore, TraceError, EXIT_INPUT_ERROR, stableStringify, sha256 };
