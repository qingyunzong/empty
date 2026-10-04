"use strict";
/**
 * mini-csp-solver: finite-domain CSP solver for up to 16 variables.
 *
 * - Domains are bitmasks (value v <-> bit 1<<v), so each domain holds up to 31 values.
 * - Constraints: allDifferent(scope) and table(scope, allowedTuples) with GAC.
 * - Propagation is a fixpoint loop; every domain narrowing is recorded on a trail
 *   so that undoing a branch restores ALL domains exactly.
 * - Search is depth-first with a node budget. Outcomes:
 *     "sat"     -> a solution (or all solutions, in count mode)
 *     "unsat"   -> the search tree was fully explored, no solution (complete tree)
 *     "unknown" -> the node budget ran out; the frontier of open nodes is reported
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Solver = exports.MAX_DOMAIN_SIZE = exports.MAX_VARS = void 0;
exports.allDifferent = allDifferent;
exports.table = table;
exports.enumerateBruteForce = enumerateBruteForce;
exports.MAX_VARS = 16;
exports.MAX_DOMAIN_SIZE = 31;
function allDifferent(...vars) {
    return { kind: "allDifferent", scope: vars.slice() };
}
function table(scope, tuples) {
    return { kind: "table", scope: scope.slice(), tuples: tuples.map((t) => t.slice()) };
}
class Solver {
    numVars;
    domains;
    constraints = [];
    trail = [];
    /** trail.length snapshots, one per active search level. */
    marks = [];
    constructor(domainSizes) {
        if (domainSizes.length === 0)
            throw new Error("need at least one variable");
        if (domainSizes.length > exports.MAX_VARS) {
            throw new Error(`at most ${exports.MAX_VARS} variables supported, got ${domainSizes.length}`);
        }
        for (const size of domainSizes) {
            if (!Number.isInteger(size) || size < 1 || size > exports.MAX_DOMAIN_SIZE) {
                throw new Error(`domain size must be an integer in 1..${exports.MAX_DOMAIN_SIZE}, got ${size}`);
            }
        }
        this.numVars = domainSizes.length;
        this.domains = domainSizes.map((size) => (1 << size) - 1);
    }
    addConstraint(constraint) {
        for (const v of constraint.scope) {
            if (!Number.isInteger(v) || v < 0 || v >= this.numVars) {
                throw new Error(`constraint references unknown variable ${v}`);
            }
        }
        if (constraint.kind === "table") {
            const arity = constraint.scope.length;
            for (const tuple of constraint.tuples) {
                if (tuple.length !== arity) {
                    throw new Error(`table tuple arity ${tuple.length} != scope arity ${arity}`);
                }
            }
        }
        this.constraints.push(constraint);
    }
    /** Current domain of variable `v` as a sorted list of values (copy). */
    domainOf(v) {
        const out = [];
        let mask = this.domains[v];
        while (mask !== 0) {
            const bit = mask & -mask;
            out.push(31 - Math.clz32(bit));
            mask ^= bit;
        }
        return out;
    }
    /** Snapshot of all domains (values, not masks). */
    snapshotDomains() {
        return this.domains.map((_, v) => this.domainOf(v));
    }
    // ---- propagation -------------------------------------------------------
    removeFromDomain(v, mask) {
        const current = this.domains[v];
        const removed = current & mask;
        if (removed === 0)
            return true;
        const next = current & ~removed;
        this.trail.push({ variable: v, removedMask: removed });
        this.domains[v] = next;
        return next !== 0;
    }
    propagateAllDifferent(scope) {
        // Remove every singleton's value from the other variables in the scope.
        let singletonMask = 0;
        let singletonCount = 0;
        for (const v of scope) {
            const d = this.domains[v];
            if ((d & (d - 1)) === 0) {
                singletonMask |= d;
                singletonCount++;
            }
        }
        // Two singletons forced to the same value violate the constraint.
        if (popcount(singletonMask) < singletonCount)
            return false;
        for (const v of scope) {
            const d = this.domains[v];
            if ((d & (d - 1)) === 0)
                continue; // singleton itself
            if (!this.removeFromDomain(v, d & singletonMask))
                return false;
        }
        return true;
    }
    propagateTable(scope, tuples) {
        // GAC: keep only values that appear in some tuple consistent with current domains.
        const arity = scope.length;
        const supported = new Array(arity).fill(0);
        for (const tuple of tuples) {
            let consistent = true;
            for (let i = 0; i < arity; i++) {
                if ((this.domains[scope[i]] & (1 << tuple[i])) === 0) {
                    consistent = false;
                    break;
                }
            }
            if (!consistent)
                continue;
            for (let i = 0; i < arity; i++)
                supported[i] |= 1 << tuple[i];
        }
        for (let i = 0; i < arity; i++) {
            const v = scope[i];
            const keep = supported[i];
            if (!this.removeFromDomain(v, this.domains[v] & ~keep))
                return false;
        }
        return true;
    }
    /** Run propagation to fixpoint. Returns false on a domain wipe-out. */
    propagate() {
        let changed = true;
        while (changed) {
            changed = false;
            for (const c of this.constraints) {
                const before = this.trail.length;
                const ok = c.kind === "allDifferent"
                    ? this.propagateAllDifferent(c.scope)
                    : this.propagateTable(c.scope, c.tuples);
                if (!ok)
                    return false;
                if (this.trail.length !== before)
                    changed = true;
            }
        }
        return true;
    }
    // ---- trail / undo --------------------------------------------------------
    mark() {
        this.marks.push(this.trail.length);
    }
    /** Restore every domain to the state at the matching mark(). */
    undo() {
        const target = this.marks.pop();
        while (this.trail.length > target) {
            const entry = this.trail.pop();
            this.domains[entry.variable] = this.domains[entry.variable] | entry.removedMask;
        }
    }
    // ---- search --------------------------------------------------------------
    pickVariable() {
        let best = -1;
        let bestSize = Infinity;
        for (let v = 0; v < this.numVars; v++) {
            const d = this.domains[v];
            const size = popcount(d);
            if (size > 1 && size < bestSize) {
                best = v;
                bestSize = size;
            }
        }
        return best;
    }
    /**
     * Depth-first search.
     * @param mode    "first" stops at the first solution; "all" enumerates all.
     * @param budget  maximum number of search nodes; Infinity for no limit.
     */
    solve(mode = "first", budget = Infinity) {
        let nodes = 0;
        let frontier = 0;
        let solutionCount = 0;
        let firstSolution = null;
        let outOfBudget = false;
        this.mark();
        const rootOk = this.propagate();
        const search = () => {
            // returns true when the whole remaining tree is exhausted
            if (outOfBudget)
                return false;
            const v = this.pickVariable();
            if (v === -1) {
                solutionCount++;
                if (firstSolution === null)
                    firstSolution = this.currentAssignment();
                return mode === "all";
            }
            if (nodes >= budget) {
                outOfBudget = true;
                frontier++;
                return false;
            }
            nodes++;
            const values = this.domainOf(v);
            let childrenUnexplored = 0;
            for (const value of values) {
                this.mark();
                const ok = this.removeFromDomain(v, ~(1 << value)) && this.propagate();
                let exhausted = true;
                if (ok)
                    exhausted = search();
                this.undo();
                if (!exhausted) {
                    childrenUnexplored++;
                    if (mode === "first" && firstSolution !== null)
                        break;
                }
            }
            if (childrenUnexplored > 0) {
                frontier += childrenUnexplored;
                return false;
            }
            return true;
        };
        if (rootOk) {
            search();
        }
        this.undo(); // restore root mark: undoing any branch restores all domains
        let status;
        if (outOfBudget) {
            status = "unknown";
        }
        else if (solutionCount > 0) {
            status = "sat";
        }
        else {
            status = "unsat";
        }
        return { status, solution: firstSolution, solutionCount, nodes, frontier };
    }
    currentAssignment() {
        const out = [];
        for (let v = 0; v < this.numVars; v++) {
            const d = this.domains[v];
            out.push(31 - Math.clz32(d & -d));
        }
        return out;
    }
}
exports.Solver = Solver;
function popcount(mask) {
    let count = 0;
    while (mask !== 0) {
        mask &= mask - 1;
        count++;
    }
    return count;
}
/**
 * Independent brute-force enumerator used to cross-check the solver.
 * Enumerates the full Cartesian product without any propagation and keeps
 * assignments satisfying every constraint.
 */
function enumerateBruteForce(domainSizes, constraints) {
    const solutions = [];
    const assignment = new Array(domainSizes.length).fill(0);
    const satisfies = () => {
        for (const c of constraints) {
            if (c.kind === "allDifferent") {
                const seen = new Set();
                for (const v of c.scope) {
                    const value = assignment[v];
                    if (seen.has(value))
                        return false;
                    seen.add(value);
                }
            }
            else {
                const row = c.scope.map((v) => assignment[v]);
                const ok = c.tuples.some((tuple) => tuple.every((t, i) => t === row[i]));
                if (!ok)
                    return false;
            }
        }
        return true;
    };
    const walk = (v) => {
        if (v === domainSizes.length) {
            if (satisfies())
                solutions.push(assignment.slice());
            return;
        }
        for (let value = 0; value < domainSizes[v]; value++) {
            assignment[v] = value;
            walk(v + 1);
        }
    };
    walk(0);
    return solutions;
}
