import { parseEvent, compareCandidate } from "./model.js";
import { sortEvents, buildGraph, findCycles } from "./topo.js";
/**
 * Incremental causal log store.
 * The published prefix is immutable; revisions that would invert it are
 * rejected atomically with the shortest conflict chain as evidence.
 */
export class LogStore {
    events = new Map();
    published = [];
    unpublishedOrder = [];
    lastSort = null;
    constructor(events = [], published = []) {
        for (const e of events)
            this.addEventChecked(e);
        this.published = [...published];
        this.recompute();
    }
    get publishedPrefix() {
        return [...this.published];
    }
    get order() {
        return [...this.published, ...this.unpublishedOrder];
    }
    get unpublished() {
        return [...this.unpublishedOrder];
    }
    get sortResult() {
        if (!this.lastSort)
            this.recompute();
        return this.lastSort;
    }
    addEventChecked(e) {
        const old = this.events.get(e.id);
        if (old) {
            if (JSON.stringify(old) !== JSON.stringify(e))
                throw new Error(`conflicting redefinition of event ${e.id}`);
            return;
        }
        this.events.set(e.id, { ...e, deps: [...e.deps] });
    }
    /** Recompute the unpublished region from scratch (published prefix fixed). */
    recompute() {
        const all = [...this.events.values()];
        this.lastSort = sortEvents(all, { prefix: this.published });
        this.unpublishedOrder = this.lastSort.order;
    }
    /** Ready candidate frontier: unpublished events whose known deps are all published. */
    readyFrontier() {
        const g = buildGraph([...this.events.values()]);
        const pub = new Set(this.published);
        const ready = [];
        for (const [id, deps] of g.depsOf) {
            if (pub.has(id))
                continue;
            if (deps.every((d) => pub.has(d)))
                ready.push(g.byId.get(id));
        }
        return ready.sort(compareCandidate).map((e) => e.id);
    }
    /** Publish the first n events of the current unpublished order (prefix stays fixed forever). */
    publish(n) {
        if (n < 0 || n > this.unpublishedOrder.length)
            throw new Error(`cannot publish ${n}; only ${this.unpublishedOrder.length} unpublished events`);
        this.published.push(...this.unpublishedOrder.slice(0, n));
        this.recompute();
    }
    /**
     * Apply a revision batch atomically.
     * Rejects the whole batch if a new dependency would invert the published
     * prefix (shortest conflict chain returned) or create a cycle.
     */
    revise(batch) {
        const newEvents = batch.events ?? [];
        const newDeps = batch.deps ?? [];
        // Tentative copy.
        const tentative = new Map();
        for (const [id, e] of this.events)
            tentative.set(id, { ...e, deps: [...e.deps] });
        for (const e of newEvents) {
            const old = tentative.get(e.id);
            if (old) {
                if (JSON.stringify(old) !== JSON.stringify(e))
                    throw new Error(`conflicting redefinition of event ${e.id}`);
            }
            else {
                tentative.set(e.id, { ...e, deps: [...e.deps] });
            }
        }
        for (const { id, dep } of newDeps) {
            const e = tentative.get(id);
            if (!e)
                throw new Error(`new dependency references unknown event: ${id}`);
            if (!e.deps.includes(dep))
                e.deps.push(dep);
        }
        const pos = new Map();
        this.published.forEach((id, i) => pos.set(id, i));
        const isPublished = (id) => pos.has(id);
        // Shortest conflict chain over all new edges (x depends on y):
        // BFS from y along "must precede" edges for the nearest node u that is
        // unpublished or published after x; chain [u, ..., y, x] is the evidence.
        const conflicts = [];
        for (const { id: x, dep: y } of newDeps) {
            if (!isPublished(x))
                continue; // unpublished region reorders freely
            if (!tentative.has(y)) {
                conflicts.push({
                    chain: [y, x],
                    reason: `${y} is unknown (missing) but required by ${x} (published at position ${pos.get(x)})`,
                });
                continue;
            }
            const queue = [y];
            const prev = new Map([[y, null]]);
            let bad = null;
            while (queue.length > 0 && bad === null) {
                const cur = queue.shift();
                const curPos = pos.get(cur);
                if (curPos === undefined || curPos > pos.get(x)) {
                    bad = cur;
                    break;
                }
                for (const d of tentative.get(cur)?.deps ?? []) {
                    if (tentative.has(d) && !prev.has(d)) {
                        prev.set(d, cur);
                        queue.push(d);
                    }
                }
            }
            if (bad !== null) {
                const chain = [];
                for (let n = bad; n !== null; n = prev.get(n))
                    chain.push(n);
                chain.push(x);
                const reason = isPublished(bad)
                    ? `${bad} is published at position ${pos.get(bad)} but must precede ${x} (published at position ${pos.get(x)})`
                    : `${bad} is unpublished but must precede ${x} (published at position ${pos.get(x)})`;
                conflicts.push({ chain, reason });
            }
        }
        conflicts.sort((a, b) => a.chain.length - b.chain.length);
        const shortest = conflicts.length > 0 ? [conflicts[0]] : [];
        // Cycle check in the unpublished region (with the tentative graph).
        const g = buildGraph([...tentative.values()]);
        const pub = new Set(this.published);
        const unpublishedIds = [...g.depsOf.keys()].filter((id) => !pub.has(id));
        const cycles = [
            ...newDeps.filter((d) => d.id === d.dep).map((d) => [d.id, d.id]),
            ...findCycles(unpublishedIds, g.depsOf),
        ];
        if (shortest.length > 0 || cycles.length > 0) {
            return { accepted: false, conflicts: shortest, cycles, order: [] };
        }
        // Commit.
        this.events = tentative;
        this.recompute();
        if (batch.publish !== undefined) {
            this.publish(batch.publish);
        }
        return { accepted: true, conflicts: [], cycles: [], order: this.order };
    }
    /** Serialize state including candidates (ready frontier) and the missing-dep index. */
    toSnapshot() {
        const sort = this.sortResult;
        const missingIndex = {};
        for (const [k, v] of sort.missingIndex)
            missingIndex[k] = v;
        return {
            version: 1,
            events: [...this.events.values()].map((e) => ({ ...e, deps: [...e.deps] })),
            published: [...this.published],
            unpublishedOrder: [...this.unpublishedOrder],
            ready: this.readyFrontier(),
            missingIndex,
        };
    }
    /** Restore from a snapshot and verify it against a full recomputation. */
    static fromSnapshot(snap) {
        if (snap.version !== 1)
            throw new Error(`unsupported snapshot version: ${snap.version}`);
        const store = new LogStore(snap.events, snap.published);
        const sort = store.sortResult;
        const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        if (!eq(store.unpublishedOrder, snap.unpublishedOrder))
            throw new Error("snapshot integrity: unpublishedOrder does not match recomputation");
        if (!eq(store.readyFrontier(), snap.ready))
            throw new Error("snapshot integrity: ready frontier does not match recomputation");
        const mi = {};
        for (const [k, v] of sort.missingIndex)
            mi[k] = v;
        if (JSON.stringify(mi) !== JSON.stringify(snap.missingIndex))
            throw new Error("snapshot integrity: missingIndex does not match recomputation");
        return store;
    }
}
/** Parse a revision batch from JSON. */
export function parseBatch(text) {
    const raw = JSON.parse(text);
    if (typeof raw !== "object" || raw === null)
        throw new Error("batch must be a JSON object");
    const b = raw;
    const batch = {};
    if (b.events !== undefined) {
        if (!Array.isArray(b.events))
            throw new Error("batch.events must be an array");
        batch.events = b.events.map((v, i) => parseEvent(v, `batch.events[${i}]`));
    }
    if (b.deps !== undefined) {
        if (!Array.isArray(b.deps))
            throw new Error("batch.deps must be an array");
        batch.deps = b.deps.map((v, i) => {
            const d = v;
            if (typeof d?.id !== "string" || typeof d?.dep !== "string")
                throw new Error(`batch.deps[${i}] must have string "id" and "dep"`);
            return { id: d.id, dep: d.dep };
        });
    }
    if (b.publish !== undefined) {
        if (typeof b.publish !== "number" || !Number.isInteger(b.publish) || b.publish < 0)
            throw new Error("batch.publish must be a non-negative integer");
        batch.publish = b.publish;
    }
    return batch;
}
