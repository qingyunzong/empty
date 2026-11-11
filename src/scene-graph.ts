import {
  IDENTITY,
  multiply,
  transformAABB,
  unionAABB,
  type AABB,
  type Mat2D,
} from './math.js';
import { GeometryRegistry } from './geometry.js';
import {
  Snapshot,
  countGeometryReferences,
  freezeNodeSnapshot,
  type NodeSnapshot,
  type SceneSnapshot,
} from './version.js';

interface InternalNode {
  id: string;
  parentId: string | null;
  childIds: Set<string>;
  local: Mat2D;
  world: Mat2D;
  subtreeBounds: AABB | null;
  geometryId: string | null;
}

/** 最近一次提交（或全树重算）的重算计量。 */
export interface RecomputeStats {
  /** 增量重算中重新计算世界变换的节点数。 */
  worldRecomputed: number;
  /** 增量重算中重新计算子树 AABB 的节点数。 */
  aabbRecomputed: number;
  /** 最近一次全树重算的世界变换节点数。 */
  fullWorldRecomputed: number;
  /** 最近一次全树重算的 AABB 节点数。 */
  fullAabbRecomputed: number;
  /** 本次提交逻辑上受影响的全部节点 id（祖先 + 后代 + 自身）。 */
  touchedNodeIds: ReadonlySet<string>;
}

export interface CumulativeStats {
  worldRecomputed: number;
  aabbRecomputed: number;
  fullWorldRecomputed: number;
  fullAabbRecomputed: number;
  commits: number;
  rejectedCommits: number;
}

interface TransformChange {
  kind: 'transform';
  nodeId: string;
  value: Mat2D;
}

interface GeometryChange {
  kind: 'geometry';
  nodeId: string;
  value: string | null;
}

interface ReparentChange {
  kind: 'reparent';
  nodeId: string;
  newParentId: string | null;
}

interface AddChange {
  kind: 'add';
  nodeId: string;
  parentId: string | null;
  local: Mat2D;
  geometryId: string | null;
}

interface RemoveChange {
  kind: 'remove';
  nodeId: string;
}

type AnyChange =
  | TransformChange
  | GeometryChange
  | ReparentChange
  | AddChange
  | RemoveChange;

/**
 * 原子事务：收集一批父级 / 变换 / 几何修改，要么整体提交成功，
 * 要么（如成环）整体拒绝，图状态与引用计数保持提交前不变。
 */
export class Transaction {
  private readonly changes: AnyChange[] = [];
  private readonly addIds = new Set<string>();
  private readonly removeIds = new Set<string>();
  private committed = false;

  constructor(private readonly graph: SceneGraph) {}

  addNode(
    nodeId: string,
    parentId: string | null,
    local: Mat2D = IDENTITY,
    geometryId: string | null = null,
  ): this {
    this.ensureOpen();
    if (this.addIds.has(nodeId)) {
      throw new Error(`Node "${nodeId}" is added more than once in this transaction`);
    }
    this.addIds.add(nodeId);
    this.changes.push({ kind: 'add', nodeId, parentId, local, geometryId });
    return this;
  }

  removeNode(nodeId: string): this {
    this.ensureOpen();
    this.removeIds.add(nodeId);
    this.changes.push({ kind: 'remove', nodeId });
    return this;
  }

  reparent(nodeId: string, newParentId: string | null): this {
    this.ensureOpen();
    this.changes.push({ kind: 'reparent', nodeId, newParentId });
    return this;
  }

  setTransform(nodeId: string, local: Mat2D): this {
    this.ensureOpen();
    this.changes.push({ kind: 'transform', nodeId, value: local });
    return this;
  }

  setGeometry(nodeId: string, geometryId: string | null): this {
    this.ensureOpen();
    this.changes.push({ kind: 'geometry', nodeId, value: geometryId });
    return this;
  }

  commit(): SceneSnapshot {
    this.ensureOpen();
    this.committed = true;
    return this.graph.commitTransaction(this);
  }

  /** @internal */
  getChanges(): readonly AnyChange[] {
    return this.changes;
  }

  /** @internal */
  getRemoveIds(): ReadonlySet<string> {
    return this.removeIds;
  }

  private ensureOpen(): void {
    if (this.committed) {
      throw new Error('Transaction has already been committed');
    }
  }
}

export class SceneGraph {
  private readonly nodes = new Map<string, InternalNode>();
  private readonly versions = new Map<number, Snapshot>();
  private activeTransaction: Transaction | null = null;
  private versionCounter = 0;

  readonly geometries = new GeometryRegistry();

  private lastStats: RecomputeStats = {
    worldRecomputed: 0,
    aabbRecomputed: 0,
    fullWorldRecomputed: 0,
    fullAabbRecomputed: 0,
    touchedNodeIds: new Set(),
  };

  private readonly cumulative: CumulativeStats = {
    worldRecomputed: 0,
    aabbRecomputed: 0,
    fullWorldRecomputed: 0,
    fullAabbRecomputed: 0,
    commits: 0,
    rejectedCommits: 0,
  };

  constructor() {
    this.publishSnapshot();
  }

  // ---------------------------------------------------------------- 事务

  beginTransaction(): Transaction {
    if (this.activeTransaction !== null) {
      throw new Error('Another transaction is already open');
    }
    this.activeTransaction = new Transaction(this);
    return this.activeTransaction;
  }

  /** @internal 仅供 {@link Transaction.commit} 调用。 */
  commitTransaction(tx: Transaction): SceneSnapshot {
    if (tx !== this.activeTransaction) {
      throw new Error('Unknown or stale transaction');
    }
    this.activeTransaction = null;

    const changes = tx.getChanges();
    const removeIds = tx.getRemoveIds();

    // 1) 静态校验：节点 / 几何存在性、禁止修改被删除节点等。
    this.validateChanges(changes, removeIds);

    // 2) 在“暂定父级关系”上做环检测；成环则整批拒绝，不产生任何副作用。
    const tentativeParent = this.buildTentativeParents(changes, removeIds);
    this.ensureAcyclic(tentativeParent);

    // 3) 记录变更前的祖先链（AABB 增量需要旧祖先）。
    const oldAabbAncestors = new Set<string>();
    for (const change of changes) {
      if (change.kind === 'remove') {
        const node = this.nodes.get(change.nodeId);
        if (node !== undefined) {
          this.collectAncestors(node.parentId, oldAabbAncestors);
        }
        continue;
      }
      if (change.kind === 'add') continue;
      this.collectAncestors(change.nodeId, oldAabbAncestors);
      if (change.kind === 'reparent') {
        const node = this.nodes.get(change.nodeId)!;
        this.collectAncestors(node.parentId, oldAabbAncestors);
      }
    }

    // 4) 应用修改（含几何 live 引用计数调整）。
    const worldDirtyRoots = new Set<string>();
    this.applyChanges(changes, worldDirtyRoots);

    const newAabbAncestors = new Set<string>();
    for (const change of changes) {
      if (change.kind === 'remove') continue;
      if (change.kind === 'add') {
        this.collectAncestors(change.nodeId, newAabbAncestors);
        continue;
      }
      this.collectAncestors(change.nodeId, newAabbAncestors);
      if (change.kind === 'reparent') {
        this.collectAncestors(change.newParentId, newAabbAncestors);
      }
    }

    const aabbDirty = new Set<string>([
      ...oldAabbAncestors,
      ...newAabbAncestors,
    ]);

    // 5) 增量重算世界变换（仅脏子树）与子树 AABB（自底向上）。
    const worldRecomputed = this.recomputeWorlds(worldDirtyRoots);
    const aabbRecomputed = this.recomputeAABBs(aabbDirty);

    const touched = new Set<string>();
    for (const id of worldRecomputed) touched.add(id);
    for (const id of aabbDirty) {
      if (this.nodes.has(id)) touched.add(id);
    }

    this.cumulative.worldRecomputed += worldRecomputed.size;
    this.cumulative.aabbRecomputed += aabbRecomputed.size;
    this.cumulative.commits += 1;
    this.lastStats = {
      worldRecomputed: worldRecomputed.size,
      aabbRecomputed: aabbRecomputed.size,
      fullWorldRecomputed: this.lastStats.fullWorldRecomputed,
      fullAabbRecomputed: this.lastStats.fullAabbRecomputed,
      touchedNodeIds: touched,
    };

    return this.publishSnapshot();
  }

  // ---------------------------------------------------------------- 校验

  private validateChanges(
    changes: readonly AnyChange[],
    removeIds: ReadonlySet<string>,
  ): void {
    const addIds = new Set<string>();
    for (const change of changes) {
      if (change.kind === 'add') {
        if (this.nodes.has(change.nodeId) || addIds.has(change.nodeId)) {
          throw new Error(`Node "${change.nodeId}" already exists`);
        }
        addIds.add(change.nodeId);
        if (change.geometryId !== null && !this.geometries.has(change.geometryId)) {
          throw new Error(`Geometry "${change.geometryId}" is not registered`);
        }
        if (
          change.parentId !== null &&
          !this.nodes.has(change.parentId) &&
          !addIds.has(change.parentId)
        ) {
          throw new Error(`Parent node "${change.parentId}" does not exist`);
        }
        if (
          change.parentId !== null &&
          this.isInsideRemovedSubtree(change.parentId, removeIds)
        ) {
          throw new Error(
            `Parent node "${change.parentId}" is inside a subtree being removed`,
          );
        }
        continue;
      }

      if (!this.nodes.has(change.nodeId)) {
        throw new Error(`Node "${change.nodeId}" does not exist`);
      }
      if (change.kind === 'geometry' && change.value !== null) {
        if (!this.geometries.has(change.value)) {
          throw new Error(`Geometry "${change.value}" is not registered`);
        }
      }
      if (change.kind === 'reparent' && change.newParentId !== null) {
        if (!this.nodes.has(change.newParentId) && !addIds.has(change.newParentId)) {
          throw new Error(`New parent "${change.newParentId}" does not exist`);
        }
        if (this.isInsideRemovedSubtree(change.newParentId, removeIds)) {
          throw new Error(
            `New parent "${change.newParentId}" is inside a subtree being removed`,
          );
        }
      }
    }
  }

  /** 判断节点本身是否被显式删除，或位于某个被删除根的子树内（基于当前结构）。 */
  private isInsideRemovedSubtree(
    nodeId: string,
    removeIds: ReadonlySet<string>,
  ): boolean {
    let current: string | null = nodeId;
    const guard = new Set<string>();
    while (current !== null) {
      if (guard.has(current)) break;
      guard.add(current);
      if (removeIds.has(current)) return true;
      current = this.nodes.get(current)?.parentId ?? null;
    }
    return false;
  }

  /** 构造应用本批修改后的暂定父级映射（仅用于环检测）。 */
  private buildTentativeParents(
    changes: readonly AnyChange[],
    removeIds: ReadonlySet<string>,
  ): Map<string, string | null> {
    const parent = new Map<string, string | null>();
    for (const [id, node] of this.nodes) {
      if (!removeIds.has(id)) parent.set(id, node.parentId);
    }
    for (const change of changes) {
      if (change.kind === 'add') {
        parent.set(change.nodeId, change.parentId);
      } else if (change.kind === 'reparent') {
        parent.set(change.nodeId, change.newParentId);
      }
    }
    return parent;
  }

  /** 沿父指针逐条链路上溯，发现重复节点即存在环。 */
  private ensureAcyclic(parent: Map<string, string | null>): void {
    for (const startId of parent.keys()) {
      const seen = new Set<string>();
      let current: string | null | undefined = startId;
      while (current !== null && current !== undefined) {
        if (seen.has(current)) {
          this.cumulative.rejectedCommits += 1;
          throw new Error(
            `Reparenting would create a cycle (detected at node "${current}")`,
          );
        }
        seen.add(current);
        current = parent.get(current);
      }
    }
  }

  /** 收集从 startId（不含）向上直到根的全部祖先节点 id。 */
  private collectAncestors(
    startId: string | null | undefined,
    out: Set<string>,
  ): void {
    if (startId === null || startId === undefined) return;
    let current: string | null = startId;
    while (current !== null) {
      if (out.has(current)) break;
      out.add(current);
      const node = this.nodes.get(current);
      current = node?.parentId ?? null;
    }
  }

  /** 收集以 nodeId 为根的整棵子树（含自身），用于删除。 */
  private collectSubtree(nodeId: string): string[] {
    const result: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      result.push(id);
      const node = this.nodes.get(id);
      if (node !== undefined) {
        stack.push(...node.childIds);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- 应用修改

  private applyChanges(
    changes: readonly AnyChange[],
    worldDirtyRoots: Set<string>,
  ): void {
    // 1) 新增节点（同批换父的目标父级可能正是新节点）。
    for (const change of changes) {
      if (change.kind !== 'add') continue;
      const node: InternalNode = {
        id: change.nodeId,
        parentId: change.parentId,
        childIds: new Set(),
        local: change.local,
        world: change.local,
        subtreeBounds: null,
        geometryId: change.geometryId,
      };
      if (change.geometryId !== null) {
        this.geometries.retainLive(change.geometryId);
      }
      this.nodes.set(change.nodeId, node);
      if (change.parentId !== null) {
        this.nodes.get(change.parentId)?.childIds.add(change.nodeId);
      }
      worldDirtyRoots.add(change.nodeId);
    }

    // 2) 重设父级：从旧父摘除、挂到新父；脏根是被移动的子树根。
    //    必须先于删除执行，这样“同批移出删除子树”的后代不会被误删。
    for (const change of changes) {
      if (change.kind !== 'reparent') continue;
      const node = this.nodes.get(change.nodeId)!;
      if (node.parentId !== null) {
        this.nodes.get(node.parentId)?.childIds.delete(node.id);
      }
      node.parentId = change.newParentId;
      if (change.newParentId !== null) {
        this.nodes.get(change.newParentId)?.childIds.add(node.id);
      }
      worldDirtyRoots.add(node.id);
    }

    // 3) 删除：按最终父子关系收集子树并释放几何 live 引用。
    for (const change of changes) {
      if (change.kind !== 'remove') continue;
      const root = this.nodes.get(change.nodeId);
      if (root === undefined) continue;
      const subtree = this.collectSubtree(change.nodeId);
      if (root.parentId !== null) {
        this.nodes.get(root.parentId)?.childIds.delete(change.nodeId);
      }
      for (const id of subtree) {
        const node = this.nodes.get(id)!;
        if (node.geometryId !== null) {
          this.geometries.releaseLive(node.geometryId);
        }
        this.nodes.delete(id);
      }
    }

    // 4) 局部变换：仅该节点所在子树的世界变换失效。
    for (const change of changes) {
      if (change.kind !== 'transform') continue;
      const node = this.nodes.get(change.nodeId)!;
      node.local = change.value;
      worldDirtyRoots.add(node.id);
    }

    // 5) 几何替换：调整 live 引用计数；只影响 AABB，不影响世界变换。
    for (const change of changes) {
      if (change.kind !== 'geometry') continue;
      const node = this.nodes.get(change.nodeId)!;
      if (node.geometryId !== null) {
        this.geometries.releaseLive(node.geometryId);
      }
      node.geometryId = change.value;
      if (change.value !== null) {
        this.geometries.retainLive(change.value);
      }
    }
  }

  // ---------------------------------------------------------------- 重算

  /**
   * 从每个脏根向下 DFS 重算世界变换。
   * 多个脏根可能有祖先关系，用 visited 去重，保证每个节点最多算一次；
   * 脏子树之外的支路完全不遍历。
   * 返回实际重算的节点 id 集合。
   */
  private recomputeWorlds(dirtyRoots: ReadonlySet<string>): Set<string> {
    const visited = new Set<string>();
    const sortedRoots = [...dirtyRoots]
      .filter((id) => this.nodes.has(id))
      .sort((a, b) => this.depthOf(a) - this.depthOf(b));

    const visit = (nodeId: string, parentWorld: Mat2D): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = this.nodes.get(nodeId)!;
      node.world = multiply(parentWorld, node.local);
      for (const childId of node.childIds) {
        visit(childId, node.world);
      }
    };

    for (const rootId of sortedRoots) {
      if (visited.has(rootId)) continue;
      const node = this.nodes.get(rootId)!;
      const parentWorld =
        node.parentId === null
          ? IDENTITY
          : (this.nodes.get(node.parentId)?.world ?? IDENTITY);
      visit(rootId, parentWorld);
    }
    return visited;
  }

  /**
   * 自底向上重算子树 AABB。脏集合包含所有受影响节点的祖先，
   * 按深度降序处理可保证父节点合并的子节点 AABB 已是最新；
   * 干净子树直接复用其缓存的 subtreeBounds，不向下遍历。
   */
  private recomputeAABBs(dirty: ReadonlySet<string>): Set<string> {
    const recomputed = new Set<string>();
    const ordered = [...dirty]
      .filter((id) => this.nodes.has(id))
      .sort((a, b) => this.depthOf(b) - this.depthOf(a));

    for (const id of ordered) {
      if (recomputed.has(id)) continue;
      recomputed.add(id);
      const node = this.nodes.get(id)!;
      let bounds: AABB | null =
        node.geometryId === null
          ? null
          : transformAABB(node.world, this.geometries.get(node.geometryId).localBounds);
      for (const childId of node.childIds) {
        const child = this.nodes.get(childId);
        if (child === undefined) continue;
        bounds = unionAABB(bounds, child.subtreeBounds);
      }
      node.subtreeBounds = bounds;
    }
    return recomputed;
  }

  /** 当前结构下节点到根的深度（根为 0）。 */
  private depthOf(nodeId: string): number {
    let depth = 0;
    let current = this.nodes.get(nodeId)?.parentId ?? null;
    const guard = new Set<string>([nodeId]);
    while (current !== null) {
      depth += 1;
      if (guard.has(current)) break;
      guard.add(current);
      current = this.nodes.get(current)?.parentId ?? null;
    }
    return depth;
  }

  /**
   * 全树重算参照：从所有根开始重算全部节点的世界变换与 AABB。
   * 用于测试中与增量重算的计数对比，不产生新版本。
   */
  recomputeFullTree(): RecomputeStats {
    const worldCount = { value: 0 };
    const aabbCount = { value: 0 };

    const recurse = (nodeId: string, parentWorld: Mat2D): void => {
      const node = this.nodes.get(nodeId)!;
      node.world = multiply(parentWorld, node.local);
      worldCount.value += 1;

      let bounds: AABB | null =
        node.geometryId === null
          ? null
          : transformAABB(node.world, this.geometries.get(node.geometryId).localBounds);
      for (const childId of node.childIds) {
        recurse(childId, node.world);
        const child = this.nodes.get(childId)!;
        bounds = unionAABB(bounds, child.subtreeBounds);
      }
      node.subtreeBounds = bounds;
      aabbCount.value += 1;
    };

    for (const [id, node] of this.nodes) {
      if (node.parentId === null) recurse(id, IDENTITY);
    }

    this.cumulative.fullWorldRecomputed += worldCount.value;
    this.cumulative.fullAabbRecomputed += aabbCount.value;
    this.lastStats = {
      worldRecomputed: this.lastStats.worldRecomputed,
      aabbRecomputed: this.lastStats.aabbRecomputed,
      fullWorldRecomputed: worldCount.value,
      fullAabbRecomputed: aabbCount.value,
      touchedNodeIds: new Set(this.nodes.keys()),
    };
    return this.lastStats;
  }

  // ---------------------------------------------------------------- 查询与版本

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  /** 当前（活）节点的世界变换。 */
  getWorld(id: string): Mat2D {
    const node = this.requireNode(id);
    return node.world;
  }

  /** 当前（活）节点的子树 AABB（世界坐标）。 */
  getSubtreeBounds(id: string): AABB | null {
    const node = this.requireNode(id);
    return node.subtreeBounds;
  }

  getLocal(id: string): Mat2D {
    return this.requireNode(id).local;
  }

  getGeometryId(id: string): string | null {
    return this.requireNode(id).geometryId;
  }

  getParentId(id: string): string | null {
    return this.requireNode(id).parentId;
  }

  getChildIds(id: string): readonly string[] {
    return [...this.requireNode(id).childIds];
  }

  getLastRecomputeStats(): RecomputeStats {
    return this.lastStats;
  }

  getCumulativeStats(): CumulativeStats {
    return { ...this.cumulative };
  }

  currentVersion(): number {
    return this.versionCounter;
  }

  /** 获取某个已提交的固定版本快照；版本不存在或已释放则抛错。 */
  getVersion(version: number): SceneSnapshot {
    const snapshot = this.versions.get(version);
    if (snapshot === undefined) {
      throw new Error(`Version ${version} does not exist or has been released`);
    }
    return snapshot;
  }

  /**
   * 释放固定版本：归还该版本对几何的版本引用，
   * 引用计数归零的几何随之回收。
   */
  releaseVersion(version: number): void {
    const snapshot = this.versions.get(version);
    if (snapshot === undefined) {
      throw new Error(`Version ${version} does not exist or has been released`);
    }
    for (const [geometryId, count] of snapshot.geometryReferences()) {
      this.geometries.releaseVersion(geometryId, count);
    }
    snapshot.markReleased();
    this.versions.delete(version);
  }

  private publishSnapshot(): SceneSnapshot {
    this.versionCounter += 1;
    const snapshots = new Map<string, NodeSnapshot>();
    for (const node of this.nodes.values()) {
      snapshots.set(
        node.id,
        freezeNodeSnapshot({
          id: node.id,
          parentId: node.parentId,
          childIds: [...node.childIds],
          local: node.local,
          world: node.world,
          subtreeBounds: node.subtreeBounds,
          geometryId: node.geometryId,
        }),
      );
    }
    const geometryRefs = countGeometryReferences(this.nodes.values());
    for (const [geometryId, count] of geometryRefs) {
      this.geometries.retainVersion(geometryId, count);
    }
    const snapshot = new Snapshot(this.versionCounter, snapshots, geometryRefs);
    this.versions.set(this.versionCounter, snapshot);
    return snapshot;
  }

  private requireNode(id: string): InternalNode {
    const node = this.nodes.get(id);
    if (node === undefined) {
      throw new Error(`Node "${id}" does not exist`);
    }
    return node;
  }
}
