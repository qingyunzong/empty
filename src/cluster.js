// 观测台站网副本核心库：epoch 成员表 + 向量时钟 + 法定读写 + 反熵修复。
// 仅使用 Node.js 标准库（本文件无依赖）。

export class ClusterError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ClusterError';
    this.code = code; // NOT_MEMBER | EPOCH_MISMATCH | QUORUM_FAIL
  }
}

// a 因果支配 b（a 是 b 的后继）
export function dominates(a, b) {
  let strictly = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av < bv) return false;
    if (av > bv) strictly = true;
  }
  return strictly;
}

export function mergeVectors(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = Math.max(out[k] ?? 0, b[k]);
  return out;
}

function vectorSum(v) {
  let s = 0;
  for (const k of Object.keys(v)) s += v[k];
  return s;
}

// 同一 key 的两条写 entry 比较：>0 表示 a 可见（胜出）。
// 因果有序按支配关系；并发写按 (writer, counter) 字典序确定性裁决，
// 保证所有节点合并结果一致（repair 与暴力全量拷贝等价的关键）。
export function compareEntries(a, b) {
  if (a.id === b.id) return 0;
  if (dominates(a.vector, b.vector)) return 1;
  if (dominates(b.vector, a.vector)) return -1;
  if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
  return a.counter - b.counter;
}

// 从 entry 集合计算每个 key 的可见 entry。
export function visibleEntries(entries) {
  const best = new Map();
  for (const e of entries) {
    const cur = best.get(e.key);
    if (!cur || compareEntries(e, cur) > 0) best.set(e.key, e);
  }
  return best;
}

export class Node {
  constructor(id) {
    this.id = id;
    this.entries = new Map(); // entryId(`${writer}:${counter}`) -> entry，只增集合
    this.clock = {};          // 已见向量时钟（各分量取 max）
  }
  has(entryId) {
    return this.entries.has(entryId);
  }
  // 幂等安装：重复投递不产生副作用，绝不删除或改写已确认历史。
  install(entry) {
    if (this.entries.has(entry.id)) return false;
    this.entries.set(entry.id, entry);
    this.clock = mergeVectors(this.clock, entry.vector);
    return true;
  }
  // 回滚未获多数派确认的投递：删除 entry 并重建时钟。
  remove(entryId) {
    if (!this.entries.delete(entryId)) return false;
    this.clock = {};
    for (const e of this.entries.values()) this.clock = mergeVectors(this.clock, e.vector);
    return true;
  }
}

export class Cluster {
  constructor() {
    this.epoch = 0;
    this.nodes = new Map();       // id -> Node（含 tombstone 节点，历史可审计）
    this.members = new Set();     // 当前 epoch 有投票权的成员
    this.tombstones = new Set();  // 已 leave 的成员：禁止计票，数据保留
    this.isolated = new Set();    // 模拟网络分区：被隔离节点消息丢弃
    this.membershipLog = [{ epoch: 0, members: [], tombstones: [] }];
  }

  #bumpEpoch() {
    this.epoch += 1;
    this.membershipLog.push({
      epoch: this.epoch,
      members: [...this.members].sort(),
      tombstones: [...this.tombstones].sort(),
    });
  }

  quorumSize() {
    return Math.floor(this.members.size / 2) + 1;
  }

  // 幂等：已是当前成员则直接返回当前 epoch，不产生新 epoch。
  join(id) {
    if (this.members.has(id)) {
      return { epoch: this.epoch, members: [...this.members].sort(), idempotent: true };
    }
    if (!this.nodes.has(id)) this.nodes.set(id, new Node(id));
    this.members.add(id);
    this.tombstones.delete(id); // 允许旧节点重新加入（tombstone 历史仍保留在 membershipLog）
    this.#bumpEpoch();
    return { epoch: this.epoch, members: [...this.members].sort(), idempotent: false };
  }

  // leave 后成为 tombstone：不再计票，节点与数据保留供审计/反熵。
  leave(id) {
    if (!this.members.has(id)) {
      throw new ClusterError('NOT_MEMBER', `${id} is not an active member of epoch ${this.epoch}`);
    }
    this.members.delete(id);
    this.tombstones.add(id);
    this.#bumpEpoch();
    return { epoch: this.epoch, tombstoned: id, members: [...this.members].sort() };
  }

  // ---- 网络分区模拟（单进程消息丢弃）----
  isolate(ids) {
    for (const id of ids) this.isolated.add(id);
    return { isolated: [...this.isolated].sort() };
  }
  heal() {
    this.isolated.clear();
    return { isolated: [] };
  }
  #reachable(id) {
    return !this.isolated.has(id);
  }

  // 写入读数：需当前 epoch 多数派确认。
  write({ key, value, node, epoch }) {
    if (epoch !== undefined && epoch !== this.epoch) {
      throw new ClusterError('EPOCH_MISMATCH', `write epoch ${epoch}, current epoch ${this.epoch}`);
    }
    const writerId = node ?? [...this.members].sort()[0];
    if (writerId === undefined || !this.members.has(writerId)) {
      throw new ClusterError('NOT_MEMBER', `${writerId} is not a voting member of epoch ${this.epoch}`);
    }
    if (!this.#reachable(writerId)) {
      throw new ClusterError('QUORUM_FAIL', `writer ${writerId} is unreachable (partitioned)`);
    }
    const writer = this.nodes.get(writerId);
    const clock = { ...writer.clock };
    clock[writerId] = (clock[writerId] ?? 0) + 1;
    const entry = {
      id: `${writerId}:${clock[writerId]}`,
      key,
      value,
      writer: writerId,
      counter: clock[writerId],
      vector: clock,
      epoch: this.epoch,
    };
    // 向当前 epoch 全部活跃成员投递；被隔离节点消息丢弃。
    const signers = [];
    for (const id of [...this.members].sort()) {
      if (!this.#reachable(id)) continue;
      this.nodes.get(id).install(entry);
      signers.push(id);
    }
    if (signers.length < this.quorumSize()) {
      // 未获多数派确认：回滚已投递副本，未确认的写绝不进入可见历史。
      for (const id of signers) this.nodes.get(id).remove(entry.id);
      throw new ClusterError('QUORUM_FAIL', `only ${signers.length}/${this.quorumSize()} acks in epoch ${this.epoch}`);
    }
    return { epoch: this.epoch, entry, signers, vector: clock };
  }

  // 读取：从当前 epoch 多数派收集，返回法定证书 {epoch, signers, vector}。
  read({ key } = {}) {
    const responders = [];
    for (const id of [...this.members].sort()) {
      if (this.#reachable(id)) responders.push(this.nodes.get(id));
    }
    if (responders.length < this.quorumSize()) {
      throw new ClusterError('QUORUM_FAIL', `only ${responders.length}/${this.quorumSize()} members reachable`);
    }
    const all = [];
    let vector = {};
    for (const n of responders) {
      all.push(...n.entries.values());
      vector = mergeVectors(vector, n.clock);
    }
    const best = visibleEntries(all);
    const certificate = { epoch: this.epoch, signers: responders.map((n) => n.id), vector };
    if (key !== undefined) {
      const e = best.get(key);
      return { certificate, key, found: e !== undefined, value: e?.value };
    }
    const values = {};
    for (const [k, e] of best) values[k] = e.value;
    return { certificate, values };
  }

  // 反熵修复：按向量缺口补齐目标节点缺失的 entry。
  // 只增不改：install 幂等且不回写历史，已确认的因果序不变。
  // 目标节点被隔离时无法修复（消息不可达）。
  repair(nodeId) {
    const targets = nodeId ? [nodeId] : [...this.nodes.keys()].sort();
    const results = [];
    for (const id of targets) {
      const target = this.nodes.get(id);
      if (!target) throw new ClusterError('NOT_MEMBER', `unknown node ${id}`);
      if (!this.#reachable(id)) {
        results.push({ node: id, reachable: false, filled: 0, vector: { ...target.clock } });
        continue;
      }
      const missing = [];
      for (const peer of this.nodes.values()) {
        if (peer === target) continue;
        if (!this.#reachable(peer.id)) continue;
        for (const entry of peer.entries.values()) {
          if (!target.has(entry.id)) missing.push(entry); // 向量缺口：目标缺失的 (writer,counter)
        }
      }
      // 按因果序补齐：支配向量的分量和严格更大，故按分量和升序拓扑安全；
      // 并发 entry 用确定字典序，且只增集合使安装顺序不影响最终可见值。
      missing.sort((a, b) => vectorSum(a.vector) - vectorSum(b.vector) || (a.id < b.id ? -1 : 1));
      let filled = 0;
      for (const entry of missing) if (target.install(entry)) filled += 1;
      results.push({ node: id, reachable: true, filled, vector: { ...target.clock } });
    }
    return nodeId ? results[0] : { repaired: results };
  }
}
