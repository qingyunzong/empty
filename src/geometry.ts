import type { AABB } from './math.js';

/**
 * 可共享几何。几何本身只携带局部空间的 AABB，
 * 同一份实例可被任意多个节点引用（共享），
 * 由 {@link GeometryRegistry} 统一管理生命周期与引用计数。
 */
export interface Geometry {
  readonly id: string;
  /** 局部坐标下的轴对齐包围盒。 */
  readonly localBounds: AABB;
}

/** 引用计数快照，供测试与诊断使用。 */
export interface GeometryRefInfo {
  readonly id: string;
  /** 当前图中（活节点）引用该几何的节点数量。 */
  readonly liveRefs: number;
  /** 所有仍保留的历史版本快照中引用该几何的次数。 */
  readonly versionRefs: number;
  /** 几何是否已因引用归零而被回收。 */
  readonly disposed: boolean;
}

interface Entry {
  geometry: Geometry;
  liveRefs: number;
  versionRefs: number;
  disposed: boolean;
}

/**
 * 几何注册表。
 *
 * 引用计数分为两部分：
 * - liveRefs：当前场景图活节点的引用；
 * - versionRefs：尚未释放的固定版本快照中的引用。
 *
 * 两者之和归零即回收（dispose）几何。版本释放时按版本中
 * 记录的引用次数递减，从而实现“引用计数随版本释放而回收”。
 */
export class GeometryRegistry {
  private readonly entries = new Map<string, Entry>();

  register(geometry: Geometry): void {
    const existing = this.entries.get(geometry.id);
    if (existing !== undefined) {
      if (existing.disposed) {
        throw new Error(`Geometry "${geometry.id}" has already been disposed`);
      }
      throw new Error(`Geometry "${geometry.id}" is already registered`);
    }
    this.entries.set(geometry.id, {
      geometry,
      liveRefs: 0,
      versionRefs: 0,
      disposed: false,
    });
  }

  get(id: string): Geometry {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.disposed) {
      throw new Error(`Geometry "${id}" is not registered`);
    }
    return entry.geometry;
  }

  has(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && !entry.disposed;
  }

  /** 活节点新增引用（节点设置几何 / 新节点加入图）。 */
  retainLive(id: string): void {
    const entry = this.require(id);
    entry.liveRefs += 1;
  }

  /** 活节点释放引用（几何被替换 / 节点移出图）。 */
  releaseLive(id: string): void {
    const entry = this.require(id);
    if (entry.liveRefs === 0) {
      throw new Error(`Geometry "${id}" live reference count underflow`);
    }
    entry.liveRefs -= 1;
    this.disposeIfUnreferenced(entry);
  }

  /** 某个固定版本保留引用（版本提交时按该版本内出现次数一次性计入）。 */
  retainVersion(id: string, count: number): void {
    if (count <= 0) return;
    const entry = this.require(id);
    entry.versionRefs += count;
  }

  /** 某个固定版本释放其全部引用（版本被调用方释放时调用）。 */
  releaseVersion(id: string, count: number): void {
    if (count <= 0) return;
    const entry = this.require(id);
    if (entry.versionRefs < count) {
      throw new Error(`Geometry "${id}" version reference count underflow`);
    }
    entry.versionRefs -= count;
    this.disposeIfUnreferenced(entry);
  }

  refInfo(id: string): GeometryRefInfo | null {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    return {
      id,
      liveRefs: entry.liveRefs,
      versionRefs: entry.versionRefs,
      disposed: entry.disposed,
    };
  }

  totalRefs(id: string): number {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.disposed) return 0;
    return entry.liveRefs + entry.versionRefs;
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(`Geometry "${id}" is not registered`);
    }
    if (entry.disposed) {
      throw new Error(`Geometry "${id}" has already been disposed`);
    }
    return entry;
  }

  private disposeIfUnreferenced(entry: Entry): void {
    if (entry.liveRefs === 0 && entry.versionRefs === 0) {
      entry.disposed = true;
      this.entries.delete(entry.geometry.id);
    }
  }
}
