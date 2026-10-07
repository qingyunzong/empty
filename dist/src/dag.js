"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TagDag = exports.CycleError = exports.UnknownTagError = void 0;
exports.compareTagIds = compareTagIds;
class UnknownTagError extends Error {
    tagId;
    constructor(tagId) {
        super(`unknown tag: ${String(tagId)}`);
        this.tagId = tagId;
        this.name = "UnknownTagError";
    }
}
exports.UnknownTagError = UnknownTagError;
class CycleError extends Error {
    constructor(message = "edge batch rejected: it would introduce a cycle") {
        super(message);
        this.name = "CycleError";
    }
}
exports.CycleError = CycleError;
function compareTagIds(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function cloneAdjacency(src) {
    const copy = new Map();
    for (const [id, next] of src)
        copy.set(id, new Set(next));
    return copy;
}
function assertAcyclic(children) {
    const indegree = new Map();
    for (const id of children.keys())
        indegree.set(id, 0);
    for (const next of children.values()) {
        for (const child of next) {
            indegree.set(child, (indegree.get(child) ?? 0) + 1);
        }
    }
    const queue = [];
    for (const [id, deg] of indegree)
        if (deg === 0)
            queue.push(id);
    let visited = 0;
    while (queue.length > 0) {
        const id = queue.pop();
        visited += 1;
        for (const child of children.get(id) ?? []) {
            const deg = indegree.get(child) - 1;
            indegree.set(child, deg);
            if (deg === 0)
                queue.push(child);
        }
    }
    if (visited !== indegree.size)
        throw new CycleError();
}
/**
 * A taxonomy of tags arranged as a directed acyclic graph.
 * An edge parent -> child means `child` is categorized under `parent`.
 * Every tag is considered an ancestor (and descendant) of itself.
 */
class TagDag {
    children = new Map();
    parents = new Map();
    addTag(id) {
        if (!this.children.has(id)) {
            this.children.set(id, new Set());
            this.parents.set(id, new Set());
        }
    }
    hasTag(id) {
        return this.children.has(id);
    }
    get tagIds() {
        return [...this.children.keys()].sort(compareTagIds);
    }
    assertTag(id) {
        if (!this.children.has(id))
            throw new UnknownTagError(id);
    }
    childIds(id) {
        this.assertTag(id);
        return [...this.children.get(id)].sort(compareTagIds);
    }
    parentIds(id) {
        this.assertTag(id);
        return [...this.parents.get(id)].sort(compareTagIds);
    }
    addEdge(parent, child) {
        this.applyEdgeBatch([{ type: "add", parent, child }]);
    }
    removeEdge(parent, child) {
        this.applyEdgeBatch([{ type: "remove", parent, child }]);
    }
    /**
     * Applies a batch of edge edits atomically: the whole batch is validated
     * against a scratch copy and rejected (leaving the graph untouched) if any
     * tag is unknown or the resulting graph would contain a cycle.
     */
    applyEdgeBatch(ops) {
        for (const op of ops) {
            this.assertTag(op.parent);
            this.assertTag(op.child);
        }
        const nextChildren = cloneAdjacency(this.children);
        for (const op of ops) {
            const bucket = nextChildren.get(op.parent);
            if (op.type === "add")
                bucket.add(op.child);
            else
                bucket.delete(op.child);
        }
        assertAcyclic(nextChildren);
        const nextParents = new Map();
        for (const id of nextChildren.keys())
            nextParents.set(id, new Set());
        for (const [parent, next] of nextChildren) {
            for (const child of next) {
                nextParents.get(child).add(parent);
            }
        }
        this.children = nextChildren;
        this.parents = nextParents;
    }
    reachableFrom(start, next) {
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length > 0) {
            const id = stack.pop();
            for (const adjacent of next.get(id) ?? []) {
                if (!seen.has(adjacent)) {
                    seen.add(adjacent);
                    stack.push(adjacent);
                }
            }
        }
        return seen;
    }
    /** All ancestors of `id`, including `id` itself. */
    ancestorsOf(id) {
        this.assertTag(id);
        return this.reachableFrom(id, this.parents);
    }
    /** All descendants of `id`, including `id` itself. */
    descendantsOf(id) {
        this.assertTag(id);
        return this.reachableFrom(id, this.children);
    }
    /**
     * All lowest common ancestors of `a` and `b`: common ancestors (a tag is
     * its own ancestor) that have no strictly closer common descendant, i.e.
     * no other common ancestor is a strict descendant of them.
     * The result is sorted by tag id.
     */
    lowestCommonAncestors(a, b) {
        this.assertTag(a);
        this.assertTag(b);
        const ancestorsA = this.ancestorsOf(a);
        const ancestorsB = this.ancestorsOf(b);
        const common = [];
        for (const id of ancestorsA)
            if (ancestorsB.has(id))
                common.push(id);
        const lowest = common.filter((candidate) => {
            const descendants = this.descendantsOf(candidate);
            return !common.some((other) => other !== candidate && descendants.has(other));
        });
        return lowest.sort(compareTagIds);
    }
}
exports.TagDag = TagDag;
