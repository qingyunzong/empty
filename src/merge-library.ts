import { computeChecksum, type Delta } from "./delta.js";

export type NodeStatus = "applied" | "quarantined" | "isolated";

export type IngestResult =
  | { status: "applied"; id: string }
  | { status: "buffered"; id: string; waitingFor: string }
  | { status: "quarantined"; id: string }
  | { status: "isolated"; id: string; ancestor: string }
  | { status: "duplicate"; id: string };

interface GraphNode {
  delta: Delta;
  status: NodeStatus;
  children: string[];
}

/**
 * 订阅合并库：
 * - 接收版本差量，每项声明父版本；父缺失时进入缓冲，父到达后自动落图；
 * - 一个父版本可有多个子版本（多分支），不强行线性化；
 * - 查询必须显式指定分支头；
 * - 摘要不匹配的差量被隔离，其后继（含乱序后补到的）一并隔离；
 * - 支持乱序重放，并可与完整版本图构建结果做等价对照。
 */
export class MergeLibrary {
  private readonly nodes = new Map<string, GraphNode>();
  /** 缺失父版本 id -> 等待它的差量列表。 */
  private readonly pending = new Map<string, Delta[]>();

  ingest(delta: Delta): IngestResult {
    if (this.nodes.has(delta.id)) {
      return { status: "duplicate", id: delta.id };
    }

    // 坏摘要：无论父版本是否就绪，该版本落图时一律记为 quarantined，
    // 保证乱序重放与完整构建得到同一状态。
    const badChecksum = delta.checksum !== computeChecksum(delta.payload);

    if (delta.parentId === null) {
      this.attach(delta, badChecksum ? "quarantined" : "applied");
      return badChecksum
        ? { status: "quarantined", id: delta.id }
        : { status: "applied", id: delta.id };
    }

    const parent = this.nodes.get(delta.parentId);
    if (!parent) {
      // 父缺失：缓冲，等待父版本到达。
      const queue = this.pending.get(delta.parentId) ?? [];
      queue.push(delta);
      this.pending.set(delta.parentId, queue);
      if (badChecksum) {
        return { status: "quarantined", id: delta.id };
      }
      return { status: "buffered", id: delta.id, waitingFor: delta.parentId };
    }

    if (badChecksum) {
      this.attach(delta, "quarantined");
      return { status: "quarantined", id: delta.id };
    }

    if (parent.status !== "applied") {
      // 父被隔离：后继一并隔离。
      this.attach(delta, "isolated");
      return { status: "isolated", id: delta.id, ancestor: delta.parentId };
    }

    this.attach(delta, "applied");
    return { status: "applied", id: delta.id };
  }

  private attach(delta: Delta, status: NodeStatus): void {
    this.nodes.set(delta.id, { delta, status, children: [] });
    if (delta.parentId !== null) {
      this.nodes.get(delta.parentId)?.children.push(delta.id);
    }
    // 父版本就绪：冲刷等待它的缓冲差量（递归处理孙代）。
    const waiting = this.pending.get(delta.id);
    if (waiting) {
      this.pending.delete(delta.id);
      for (const child of waiting) {
        this.ingest(child);
      }
    }
  }

  /** 从根到指定分支头的差量路径；查询必须指定分支头。 */
  query(branchHeadId: string): Delta[] {
    if (branchHeadId === undefined || branchHeadId === null) {
      throw new Error("查询必须指定分支头（branch head）");
    }
    const head = this.nodes.get(branchHeadId);
    if (!head) {
      throw new Error(`未知分支头: ${branchHeadId}`);
    }
    if (head.status !== "applied") {
      throw new Error(`分支头已被隔离: ${branchHeadId}`);
    }
    const path: Delta[] = [];
    let cursor: GraphNode | undefined = head;
    while (cursor) {
      path.push(cursor.delta);
      cursor = cursor.delta.parentId
        ? this.nodes.get(cursor.delta.parentId)
        : undefined;
    }
    return path.reverse();
  }

  /** 沿分支头路径合并 payload，得到该分支头的版本状态。 */
  mergeState(branchHeadId: string): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const delta of this.query(branchHeadId)) {
      Object.assign(state, delta.payload);
    }
    return state;
  }

  /** 当前所有已落图分支的叶子（分支头），按 id 排序；被隔离的子代不算分支延伸。 */
  heads(): string[] {
    const result: string[] = [];
    for (const [id, node] of this.nodes) {
      const hasAppliedChild = node.children.some(
        (childId) => this.nodes.get(childId)?.status === "applied",
      );
      if (node.status === "applied" && !hasAppliedChild) {
        result.push(id);
      }
    }
    return result.sort();
  }

  /** 仍在缓冲中等待父版本的差量 id。 */
  buffered(): string[] {
    const result: string[] = [];
    for (const queue of this.pending.values()) {
      for (const delta of queue) {
        result.push(delta.id);
      }
    }
    return result.sort();
  }

  /** 被隔离（含坏摘要本体）的版本 id。 */
  isolated(): string[] {
    const result: string[] = [];
    for (const [id, node] of this.nodes) {
      if (node.status !== "applied") {
        result.push(id);
      }
    }
    return result.sort();
  }

  /**
   * 版本图的规范化快照：仅取决于图结构与节点状态，
   * 与差量到达顺序无关，用于乱序重放与完整构建的等价对照。
   */
  snapshot(): string {
    const entries = [...this.nodes.values()]
      .map((node) => ({
        id: node.delta.id,
        parentId: node.delta.parentId,
        status: node.status,
        payload: node.delta.payload,
        children: [...node.children].sort(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify(entries);
  }

  /** 按给定顺序（可乱序）重放差量流，构建版本图。 */
  static replay(deltas: Iterable<Delta>): MergeLibrary {
    const lib = new MergeLibrary();
    for (const delta of deltas) {
      lib.ingest(delta);
    }
    return lib;
  }

  /** 对照两个版本图是否等价（乱序重放 vs 完整构建）。 */
  static equivalent(a: MergeLibrary, b: MergeLibrary): boolean {
    return a.snapshot() === b.snapshot();
  }
}
