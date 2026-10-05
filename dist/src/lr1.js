/** Canonical LR(1) automaton construction, conflict analysis, LALR(1) merge check. */
import { EOF, formatProduction } from "./grammar.js";
export function itemKey(it) {
    return `${it.prod}.${it.dot}.${it.la}`;
}
export function coreKey(it) {
    return `${it.prod}.${it.dot}`;
}
/** FIRST sets for nonterminals; terminals map to themselves. */
export function computeFirst(grammar) {
    const first = new Map();
    for (const t of grammar.terminals)
        first.set(t, new Set([t]));
    for (const nt of grammar.nonterminals)
        first.set(nt, new Set());
    let changed = true;
    while (changed) {
        changed = false;
        for (const p of grammar.productions) {
            const target = first.get(p.lhs);
            if (p.rhs.length === 0) {
                if (!target.has("")) {
                    target.add("");
                    changed = true;
                }
                continue;
            }
            let nullablePrefix = true;
            for (const sym of p.rhs) {
                const symFirst = first.get(sym);
                for (const f of symFirst) {
                    if (f !== "" && !target.has(f)) {
                        target.add(f);
                        changed = true;
                    }
                }
                if (!symFirst.has("")) {
                    nullablePrefix = false;
                    break;
                }
            }
            if (nullablePrefix && !target.has("")) {
                target.add("");
                changed = true;
            }
        }
    }
    return first;
}
/** Terminals that can begin the sequence `symbols` followed by lookahead `la`. */
export function firstOfSequence(first, symbols, la) {
    const result = new Set();
    let nullablePrefix = true;
    for (const sym of symbols) {
        const symFirst = first.get(sym);
        for (const f of symFirst)
            if (f !== "")
                result.add(f);
        if (!symFirst.has("")) {
            nullablePrefix = false;
            break;
        }
    }
    if (nullablePrefix)
        result.add(la);
    return result;
}
export class CanonicalLR1 {
    grammar;
    first;
    /** item sets, keyed by state id; each set maps itemKey -> Item */
    states = [];
    /** transitions[stateId] : symbol -> stateId */
    transitions = [];
    prodsByLhs;
    constructor(grammar) {
        this.grammar = grammar;
        this.first = computeFirst(grammar);
        this.prodsByLhs = new Map();
        grammar.productions.forEach((p, i) => {
            const list = this.prodsByLhs.get(p.lhs) ?? [];
            list.push(i);
            this.prodsByLhs.set(p.lhs, list);
        });
        this.build();
    }
    closure(seed) {
        const items = new Map();
        const worklist = [];
        for (const it of seed) {
            const k = itemKey(it);
            if (!items.has(k)) {
                items.set(k, it);
                worklist.push(it);
            }
        }
        while (worklist.length > 0) {
            const it = worklist.pop();
            const p = this.grammar.productions[it.prod];
            const B = p.rhs[it.dot];
            if (B === undefined || !this.grammar.nonterminals.has(B))
                continue;
            const beta = p.rhs.slice(it.dot + 1);
            const lookaheads = firstOfSequence(this.first, beta, it.la);
            for (const prodIdx of this.prodsByLhs.get(B) ?? []) {
                for (const b of lookaheads) {
                    const next = { prod: prodIdx, dot: 0, la: b };
                    const k = itemKey(next);
                    if (!items.has(k)) {
                        items.set(k, next);
                        worklist.push(next);
                    }
                }
            }
        }
        return items;
    }
    goto(state, symbol) {
        const moved = [];
        for (const it of state.values()) {
            const p = this.grammar.productions[it.prod];
            if (p.rhs[it.dot] === symbol)
                moved.push({ prod: it.prod, dot: it.dot + 1, la: it.la });
        }
        return moved.length === 0 ? new Map() : this.closure(moved);
    }
    static stateKey(state) {
        return [...state.keys()].sort().join("|");
    }
    build() {
        const start = this.closure([{ prod: 0, dot: 0, la: EOF }]);
        const ids = new Map();
        const addState = (s) => {
            const key = CanonicalLR1.stateKey(s);
            const existing = ids.get(key);
            if (existing !== undefined)
                return existing;
            const id = this.states.length;
            ids.set(key, id);
            this.states.push(s);
            this.transitions.push(new Map());
            return id;
        };
        const startId = addState(start);
        const queue = [startId];
        while (queue.length > 0) {
            const id = queue.shift();
            const state = this.states[id];
            // candidate goto symbols, in first-appearance order for deterministic output
            const symbols = [];
            for (const it of state.values()) {
                const sym = this.grammar.productions[it.prod].rhs[it.dot];
                if (sym !== undefined && !symbols.includes(sym))
                    symbols.push(sym);
            }
            for (const sym of symbols) {
                const target = this.goto(state, sym);
                const before = this.states.length;
                const targetId = addState(target);
                if (this.states.length > before)
                    queue.push(targetId);
                this.transitions[id].set(sym, targetId);
            }
        }
    }
}
/**
 * Find conflicts directly from a collection of item sets + transition tables.
 * Works for both the canonical automaton and the merged LALR automaton.
 */
export function findConflicts(grammar, states, transitions) {
    const conflicts = [];
    for (let id = 0; id < states.length; id++) {
        const state = states[id];
        const trans = transitions[id];
        const reduces = new Map(); // lookahead -> production indices
        for (const it of state.values()) {
            const p = grammar.productions[it.prod];
            if (it.dot !== p.rhs.length)
                continue;
            if (it.prod === 0)
                continue; // augmented accept item
            const list = reduces.get(it.la) ?? [];
            list.push(it.prod);
            reduces.set(it.la, list);
        }
        const lookaheads = new Set([...reduces.keys()]);
        for (const [sym] of trans) {
            if (grammar.terminals.has(sym))
                lookaheads.add(sym);
        }
        for (const la of [...lookaheads].sort()) {
            const shiftTo = trans.get(la);
            const reds = reduces.get(la) ?? [];
            if (shiftTo !== undefined && reds.length >= 1) {
                conflicts.push({ stateId: id, lookahead: la, kind: "shift-reduce", shiftTo, reduceProds: reds });
            }
            else if (reds.length >= 2) {
                conflicts.push({ stateId: id, lookahead: la, kind: "reduce-reduce", shiftTo: null, reduceProds: reds });
            }
        }
    }
    return conflicts;
}
/**
 * BFS shortest path (in grammar symbols) from state 0 to `targetId`.
 * Returns the symbol sequence; empty array if target is state 0.
 */
export function shortestPath(transitions, targetId) {
    if (targetId === 0)
        return [];
    const prev = new Map();
    const visited = new Set([0]);
    const queue = [0];
    while (queue.length > 0) {
        const id = queue.shift();
        for (const [sym, to] of transitions[id]) {
            if (visited.has(to))
                continue;
            visited.add(to);
            prev.set(to, { from: id, symbol: sym });
            if (to === targetId) {
                const path = [];
                let cur = targetId;
                while (cur !== 0) {
                    const step = prev.get(cur);
                    path.unshift(step.symbol);
                    cur = step.from;
                }
                return path;
            }
            queue.push(to);
        }
    }
    throw new Error(`状态 ${targetId} 不可达`);
}
/**
 * Merge canonical LR(1) states by LR(0) core (LALR(1)) and report conflicts
 * that the merge introduces. These must NOT be counted as real conflicts of
 * the grammar — the canonical automaton is the source of truth.
 */
export function analyzeLalrMerge(auto) {
    const { grammar, states, transitions } = auto;
    // group canonical states by core (set of "prod.dot")
    const groupOf = new Map();
    const groups = [];
    const stateGroup = [];
    for (let id = 0; id < states.length; id++) {
        const core = [...new Set([...states[id].values()].map((it) => coreKey(it)))]
            .sort()
            .join("|");
        let g = groupOf.get(core);
        if (g === undefined) {
            g = groups.length;
            groupOf.set(core, g);
            groups.push([]);
        }
        groups[g].push(id);
        stateGroup.push(g);
    }
    // merged item sets (union of lookaheads) and merged transitions
    const mergedStates = groups.map(() => new Map());
    const mergedTrans = groups.map(() => new Map());
    for (let id = 0; id < states.length; id++) {
        const g = stateGroup[id];
        const target = mergedStates[g];
        for (const [k, it] of states[id])
            if (!target.has(k))
                target.set(k, it);
        for (const [sym, to] of transitions[id]) {
            mergedTrans[g].set(sym, stateGroup[to]);
        }
    }
    const mergedConflicts = findConflicts(grammar, mergedStates, mergedTrans);
    const canonicalConflicts = findConflicts(grammar, states, transitions);
    // A merged conflict is "introduced" if no canonical state in the same group
    // has a conflict on the same lookahead.
    const conflictLasByState = new Map();
    for (const c of canonicalConflicts) {
        const set = conflictLasByState.get(c.stateId) ?? new Set();
        set.add(c.lookahead);
        conflictLasByState.set(c.stateId, set);
    }
    const introduced = [];
    for (const mc of mergedConflicts) {
        const members = groups[mc.stateId];
        const existed = members.some((sid) => conflictLasByState.get(sid)?.has(mc.lookahead));
        if (!existed)
            introduced.push(mc);
    }
    return { mergedStateCount: groups.length, introducedConflicts: introduced, groups };
}
/** Follow a symbol path from state 0; returns the reached state id or null. */
export function followPath(transitions, path) {
    let cur = 0;
    for (const sym of path) {
        const next = transitions[cur].get(sym);
        if (next === undefined)
            return null;
        cur = next;
    }
    return cur;
}
export function formatItem(grammar, it) {
    const p = grammar.productions[it.prod];
    const rhs = [...p.rhs];
    rhs.splice(it.dot, 0, "·");
    return `[${p.lhs} -> ${rhs.join(" ")}, ${it.la}]`;
}
export function describeConflict(grammar, c) {
    const lines = [];
    const kindName = c.kind === "shift-reduce" ? "移入-归约冲突" : "归约-归约冲突";
    lines.push(`状态 ${c.stateId}，前瞻符号 '${c.lookahead}'：${kindName}`);
    if (c.shiftTo !== null)
        lines.push(`  移入 -> 状态 ${c.shiftTo}`);
    for (const pi of c.reduceProds) {
        lines.push(`  归约 ${formatProduction(grammar.productions[pi])}`);
    }
    return lines.join("\n");
}
