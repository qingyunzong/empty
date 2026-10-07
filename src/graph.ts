export class GraphError extends Error {}
export class UnknownCommitError extends GraphError {}
export class DuplicateCommitError extends GraphError {}
export class CycleError extends GraphError {}

/**
 * 多父提交版本图（DAG）。边方向：子提交 -> 父提交。
 * 支持增量插入：addCommit 追加新提交，addParents 为已有提交追加父边；
 * 任何会产生环的插入都会被拒绝（抛出 CycleError），且操作保持原子性。
 */
export class VersionGraph {
  private readonly parents = new Map<string, string[]>();
  private readonly children = new Map<string, string[]>();

  get size(): number {
    return this.parents.size;
  }

  has(id: string): boolean {
    return this.parents.has(id);
  }

  commits(): string[] {
    return [...this.parents.keys()];
  }

  getParents(id: string): readonly string[] {
    const entry = this.parents.get(id);
    if (!entry) throw new UnknownCommitError(`unknown commit: ${id}`);
    return entry;
  }

  getChildren(id: string): readonly string[] {
    const entry = this.children.get(id);
    if (!entry) throw new UnknownCommitError(`unknown commit: ${id}`);
    return entry;
  }

  /** 追加新提交；父提交必须已存在。新节点没有出向被引用，不可能成环。 */
  addCommit(id: string, parents: readonly string[] = []): void {
    if (this.parents.has(id)) {
      throw new DuplicateCommitError(`duplicate commit: ${id}`);
    }
    const unique = [...new Set(parents)];
    for (const parent of unique) {
      if (!this.parents.has(parent)) {
        throw new UnknownCommitError(`unknown parent commit: ${parent}`);
      }
    }
    this.parents.set(id, unique);
    this.children.set(id, []);
    for (const parent of unique) {
      this.children.get(parent)!.push(id);
    }
  }

  /**
   * 为已有提交 child 增量追加父边。若任一新边会构成环
   * （即 child 已是该父提交的祖先，含自身），整体拒绝并抛 CycleError。
   */
  addParents(child: string, newParents: readonly string[]): void {
    const existing = this.parents.get(child);
    if (!existing) throw new UnknownCommitError(`unknown commit: ${child}`);
    const toAdd: string[] = [];
    for (const parent of new Set(newParents)) {
      if (!this.parents.has(parent)) {
        throw new UnknownCommitError(`unknown parent commit: ${parent}`);
      }
      if (existing.includes(parent) || toAdd.includes(parent)) continue;
      if (parent === child) {
        throw new CycleError(`self-loop on commit: ${child}`);
      }
      if (this.isAncestor(child, parent)) {
        throw new CycleError(
          `adding edge ${child} -> ${parent} would create a cycle`,
        );
      }
      toAdd.push(parent);
    }
    for (const parent of toAdd) {
      existing.push(parent);
      this.children.get(parent)!.push(child);
    }
  }

  /** ancestor 是否为 descendant 的祖先（含自身，自反闭包）。 */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (!this.parents.has(ancestor)) {
      throw new UnknownCommitError(`unknown commit: ${ancestor}`);
    }
    if (!this.parents.has(descendant)) {
      throw new UnknownCommitError(`unknown commit: ${descendant}`);
    }
    const visited = new Set<string>([descendant]);
    const stack = [descendant];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === ancestor) return true;
      for (const parent of this.parents.get(node)!) {
        if (!visited.has(parent)) {
          visited.add(parent);
          stack.push(parent);
        }
      }
    }
    return false;
  }

  /** id 的全部祖先集合（含自身）。 */
  ancestorsOf(id: string): Set<string> {
    if (!this.parents.has(id)) {
      throw new UnknownCommitError(`unknown commit: ${id}`);
    }
    const result = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const parent of this.parents.get(node)!) {
        if (!result.has(parent)) {
          result.add(parent);
          stack.push(parent);
        }
      }
    }
    return result;
  }

  /** id 的全部后代集合（含自身）。 */
  descendantsOf(id: string): Set<string> {
    if (!this.children.has(id)) {
      throw new UnknownCommitError(`unknown commit: ${id}`);
    }
    const result = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const child of this.children.get(node)!) {
        if (!result.has(child)) {
          result.add(child);
          stack.push(child);
        }
      }
    }
    return result;
  }
}
