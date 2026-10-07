export declare class GraphError extends Error {
}
export declare class UnknownCommitError extends GraphError {
}
export declare class DuplicateCommitError extends GraphError {
}
export declare class CycleError extends GraphError {
}
/**
 * 多父提交版本图（DAG）。边方向：子提交 -> 父提交。
 * 支持增量插入：addCommit 追加新提交，addParents 为已有提交追加父边；
 * 任何会产生环的插入都会被拒绝（抛出 CycleError），且操作保持原子性。
 */
export declare class VersionGraph {
    private readonly parents;
    private readonly children;
    get size(): number;
    has(id: string): boolean;
    commits(): string[];
    getParents(id: string): readonly string[];
    getChildren(id: string): readonly string[];
    /** 追加新提交；父提交必须已存在。新节点没有出向被引用，不可能成环。 */
    addCommit(id: string, parents?: readonly string[]): void;
    /**
     * 为已有提交 child 增量追加父边。若任一新边会构成环
     * （即 child 已是该父提交的祖先，含自身），整体拒绝并抛 CycleError。
     */
    addParents(child: string, newParents: readonly string[]): void;
    /** ancestor 是否为 descendant 的祖先（含自身，自反闭包）。 */
    isAncestor(ancestor: string, descendant: string): boolean;
    /** id 的全部祖先集合（含自身）。 */
    ancestorsOf(id: string): Set<string>;
    /** id 的全部后代集合（含自身）。 */
    descendantsOf(id: string): Set<string>;
}
