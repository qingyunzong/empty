import type { AABB, Mat2D } from './math.js';
import type { Geometry } from './geometry.js';

/**
 * 固定版本中的节点快照。所有字段均为提交时刻的值，
 * 后续提交不会改变已保留版本的内容。
 */
export interface NodeSnapshot {
  readonly id: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly local: Mat2D;
  readonly world: Mat2D;
  readonly subtreeBounds: AABB | null;
  readonly geometryId: string | null;
}

/** 某次提交产生的不可变场景快照。 */
export interface SceneSnapshot {
  readonly version: number;
  getNode(id: string): NodeSnapshot | null;
  nodeIds(): readonly string[];
  roots(): readonly NodeSnapshot[];
  /** 该版本中每个几何 id 被引用的次数（用于版本释放时回收）。 */
  geometryReferences(): ReadonlyMap<string, number>;
  isReleased(): boolean;
}

export class Snapshot implements SceneSnapshot {
  readonly version: number;
  private readonly nodes: ReadonlyMap<string, NodeSnapshot>;
  private readonly geometryRefs: ReadonlyMap<string, number>;
  private released = false;

  constructor(
    version: number,
    nodes: ReadonlyMap<string, NodeSnapshot>,
    geometryRefs: ReadonlyMap<string, number>,
  ) {
    this.version = version;
    this.nodes = nodes;
    this.geometryRefs = geometryRefs;
  }

  getNode(id: string): NodeSnapshot | null {
    this.ensureLive();
    return this.nodes.get(id) ?? null;
  }

  nodeIds(): readonly string[] {
    this.ensureLive();
    return [...this.nodes.keys()];
  }

  roots(): readonly NodeSnapshot[] {
    this.ensureLive();
    const result: NodeSnapshot[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === null) result.push(node);
    }
    return result;
  }

  geometryReferences(): ReadonlyMap<string, number> {
    this.ensureLive();
    return this.geometryRefs;
  }

  isReleased(): boolean {
    return this.released;
  }

  markReleased(): void {
    this.released = true;
  }

  private ensureLive(): void {
    if (this.released) {
      throw new Error(`Snapshot version ${this.version} has been released`);
    }
  }
}

/** 由内部可变节点构造对外不可变的节点快照（数组冻结，防止外部篡改）。 */
export function freezeNodeSnapshot(node: {
  id: string;
  parentId: string | null;
  childIds: readonly string[];
  local: Mat2D;
  world: Mat2D;
  subtreeBounds: AABB | null;
  geometryId: string | null;
}): NodeSnapshot {
  return {
    id: node.id,
    parentId: node.parentId,
    childIds: Object.freeze([...node.childIds]),
    local: node.local,
    world: node.world,
    subtreeBounds: node.subtreeBounds,
    geometryId: node.geometryId,
  };
}

/** 统计一个版本内各几何的引用次数。 */
export function countGeometryReferences(
  nodes: Iterable<{ geometryId: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.geometryId !== null) {
      counts.set(node.geometryId, (counts.get(node.geometryId) ?? 0) + 1);
    }
  }
  return counts;
}

export type { Geometry };
