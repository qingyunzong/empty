/**
 * Search frontier with full serializability.
 *
 * One deterministic engine powers both BFS (priority = g) and A*
 * (priority = g + h). Ties break by insertion counter (FIFO), so the
 * expansion order is a pure function of the problem and mode.
 *
 * snapshot() captures the ENTIRE search state (open list, closed set,
 * parent pointers, counter, visit log) as plain JSON data. Restoring from
 * a snapshot and continuing yields exactly the same visit order as an
 * uninterrupted run.
 */
import { initialState, isGoal, stateKey, successors, } from "./model.js";
/** Binary min-heap ordered by (prio, seq). */
class Heap {
    items = [];
    get size() {
        return this.items.length;
    }
    push(e) {
        this.items.push(e);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.less(i, parent))
                break;
            this.swap(i, parent);
            i = parent;
        }
    }
    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0 && last) {
            this.items[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < this.items.length && this.less(l, m))
                    m = l;
                if (r < this.items.length && this.less(r, m))
                    m = r;
                if (m === i)
                    break;
                this.swap(i, m);
                i = m;
            }
        }
        return top;
    }
    toArray() {
        return this.items.map((e) => ({ ...e, state: { bits: e.state.bits, res: [...e.state.res] } }));
    }
    less(a, b) {
        const x = this.items[a];
        const y = this.items[b];
        return x.prio < y.prio || (x.prio === y.prio && x.seq < y.seq);
    }
    swap(a, b) {
        const t = this.items[a];
        this.items[a] = this.items[b];
        this.items[b] = t;
    }
}
export class Search {
    mode;
    h;
    problem;
    open = new Heap();
    closed = new Set();
    parents = new Map();
    gBest = new Map();
    seq = 0;
    goalKey = null;
    /** Keys in expansion order — the visit order that pause/resume preserves. */
    visitLog = [];
    /** The most recently expanded node (key, g, h-priority inputs). */
    lastExpanded = null;
    constructor(problem, mode, h = () => 0, snapshot) {
        this.problem = problem;
        this.mode = mode;
        this.h = h;
        if (snapshot) {
            if (snapshot.mode !== mode)
                throw new Error(`snapshot mode ${snapshot.mode} != ${mode}`);
            for (const e of snapshot.open)
                this.open.push({ ...e, state: { ...e.state, res: [...e.state.res] } });
            this.closed = new Set(snapshot.closed);
            this.parents = new Map(snapshot.parents.map(([k, v]) => [k, { ...v }]));
            this.gBest = new Map(snapshot.gBest);
            this.seq = snapshot.seq;
            this.visitLog.push(...snapshot.visitLog);
            this.goalKey = snapshot.goalKey;
        }
        else {
            const s = initialState(problem);
            this.gBest.set(stateKey(s), 0);
            this.enqueue(s, 0);
        }
    }
    prio(g, s) {
        return this.mode === "bfs" ? g : g + this.h(s);
    }
    enqueue(s, g) {
        this.open.push({ key: stateKey(s), state: s, g, prio: this.prio(g, s), seq: this.seq++ });
    }
    /** Expand one node. Returns false when the search is finished. */
    step() {
        if (this.goalKey !== null)
            return false;
        for (;;) {
            const e = this.open.pop();
            if (!e)
                return false; // frontier exhausted: unsolvable
            if (this.closed.has(e.key))
                continue;
            if (e.g > (this.gBest.get(e.key) ?? Number.POSITIVE_INFINITY))
                continue; // stale entry
            this.closed.add(e.key);
            this.visitLog.push(e.key);
            this.lastExpanded = { key: e.key, g: e.g, state: e.state };
            if (isGoal(this.problem, e.state)) {
                this.goalKey = e.key;
                return false;
            }
            for (const { action, state: ns } of successors(this.problem, e.state)) {
                const nk = stateKey(ns);
                if (this.closed.has(nk))
                    continue;
                const g = e.g + 1;
                if (g >= (this.gBest.get(nk) ?? Number.POSITIVE_INFINITY))
                    continue;
                // Strictly better path: relax, record parent, enqueue.
                this.gBest.set(nk, g);
                this.parents.set(nk, { key: e.key, action: action.name });
                this.enqueue(ns, g);
            }
            return true;
        }
    }
    /** Run to completion (or until `maxSteps` expansions, for pausing). */
    run(maxSteps = Number.POSITIVE_INFINITY) {
        let n = 0;
        while (n < maxSteps && this.step())
            n++;
    }
    get solved() {
        return this.goalKey !== null;
    }
    get exhausted() {
        return this.goalKey === null && this.open.size === 0;
    }
    plan() {
        if (this.goalKey === null)
            return null;
        const plan = [];
        let cur = this.goalKey;
        for (;;) {
            const edge = this.parents.get(cur);
            if (!edge)
                break;
            plan.push(edge.action);
            cur = edge.key;
        }
        return plan.reverse();
    }
    snapshot() {
        return {
            mode: this.mode,
            open: this.open.toArray(),
            closed: [...this.closed],
            parents: [...this.parents.entries()].map(([k, v]) => [k, { ...v }]),
            gBest: [...this.gBest.entries()],
            seq: this.seq,
            visitLog: [...this.visitLog],
            goalKey: this.goalKey,
        };
    }
    static fromSnapshot(problem, snap, h = () => 0) {
        return new Search(problem, snap.mode, h, snap);
    }
}
export function serializeSnapshot(snap) {
    return JSON.stringify(snap, null, 2);
}
export function deserializeSnapshot(json) {
    const v = JSON.parse(json);
    if (v.mode !== "bfs" && v.mode !== "astar")
        throw new Error("bad snapshot mode");
    if (!Array.isArray(v.open) || !Array.isArray(v.closed) || !Array.isArray(v.visitLog) || !Array.isArray(v.gBest)) {
        throw new Error("malformed snapshot");
    }
    return v;
}
