"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Spreadsheet = exports.CycleError = exports.CYCLE = exports.DIV_ZERO = void 0;
const formula_1 = require("./formula");
exports.DIV_ZERO = "#DIV/0!";
exports.CYCLE = "#CYCLE!";
class CycleError extends Error {
    path;
    constructor(path) {
        super(`circular reference: ${path.join(" -> ")}`);
        this.path = path;
        this.name = "CycleError";
    }
}
exports.CycleError = CycleError;
const num = (value) => ({ kind: "num", value });
const err = (code, path) => path === undefined ? { kind: "error", code } : { kind: "error", code, path };
function evalExpr(expr, read) {
    switch (expr.type) {
        case "num":
            return num(expr.value);
        case "ref":
            return read(expr.ref);
        case "neg": {
            const v = evalExpr(expr.operand, read);
            return v.kind === "error" ? v : num(-v.value);
        }
        case "bin": {
            const l = evalExpr(expr.left, read);
            if (l.kind === "error")
                return l;
            const r = evalExpr(expr.right, read);
            if (r.kind === "error")
                return r;
            const a = l.value;
            const b = r.value;
            switch (expr.op) {
                case "+":
                    return num(a + b);
                case "-":
                    return num(a - b);
                case "*":
                    return num(a * b);
                case "/":
                    return b === 0 ? err(exports.DIV_ZERO) : num(Math.trunc(a / b));
                case "=":
                    return num(a === b ? 1 : 0);
                case "<>":
                    return num(a !== b ? 1 : 0);
                case "<":
                    return num(a < b ? 1 : 0);
                case "<=":
                    return num(a <= b ? 1 : 0);
                case ">":
                    return num(a > b ? 1 : 0);
                case ">=":
                    return num(a >= b ? 1 : 0);
            }
        }
        case "if": {
            const cond = evalExpr(expr.cond, read);
            if (cond.kind === "error")
                return cond;
            // Only the taken branch is evaluated, so only its refs are tracked.
            return evalExpr(cond.value !== 0 ? expr.then : expr.otherwise, read);
        }
    }
}
/**
 * Shared evaluator used both by the live sheet (with dependency tracking and
 * a persistent cache) and by evaluateAll (fresh memo, no tracking).
 */
function evaluateCell(formulas, ref, memo, stack, onRead) {
    const cached = memo.get(ref);
    if (cached !== undefined)
        return cached;
    const loopAt = stack.indexOf(ref);
    if (loopAt !== -1) {
        throw new CycleError([...stack.slice(loopAt), ref]);
    }
    stack.push(ref);
    const read = (dep) => {
        const dependent = stack[stack.length - 1];
        if (onRead && dependent !== undefined)
            onRead(dependent, dep);
        return evaluateCell(formulas, dep, memo, stack, onRead);
    };
    try {
        const formula = formulas.get(ref);
        let result;
        if (formula === undefined)
            result = num(0);
        else if (typeof formula === "number")
            result = num(formula);
        else
            result = evalExpr(formula, read);
        memo.set(ref, result);
        return result;
    }
    catch (e) {
        if (e instanceof CycleError) {
            memo.set(ref, err(exports.CYCLE, e.path));
        }
        throw e;
    }
    finally {
        stack.pop();
    }
}
function copyGraph(g) {
    const out = new Map();
    for (const [k, v] of g)
        out.set(k, new Set(v));
    return out;
}
class Spreadsheet {
    formulas = new Map();
    cache = new Map();
    deps = new Map(); // cell -> cells it reads
    dependents = new Map(); // cell -> cells reading it
    evalStack = [];
    snapshots = [];
    /** Set a cell to an integer literal or a formula string starting with '='. */
    setCell(ref, input) {
        const cell = (0, formula_1.normalizeRef)(ref);
        let formula;
        if (typeof input === "number") {
            formula = Math.trunc(input);
        }
        else if (input.startsWith("=")) {
            formula = (0, formula_1.parseFormula)(input.slice(1));
        }
        else {
            throw new Error(`cell input must be an integer or a '=...' formula: ${input}`);
        }
        this.invalidate(cell);
        this.formulas.set(cell, formula);
    }
    /** Remove a cell's formula entirely. */
    clearCell(ref) {
        const cell = (0, formula_1.normalizeRef)(ref);
        this.invalidate(cell);
        this.formulas.delete(cell);
    }
    /** Evaluate a cell, lazily (re)tracking dependencies along the way. */
    getValue(ref) {
        const cell = (0, formula_1.normalizeRef)(ref);
        try {
            return evaluateCell(this.formulas, cell, this.cache, this.evalStack, this.trackRead);
        }
        catch (e) {
            if (e instanceof CycleError) {
                return this.cache.get(cell);
            }
            throw e;
        }
    }
    /** Cells that `ref` directly reads, given the branches actually executed. */
    getDependencies(ref) {
        return [...(this.deps.get((0, formula_1.normalizeRef)(ref)) ?? [])].sort();
    }
    /** Cells that directly read `ref`. */
    getDependents(ref) {
        return [...(this.dependents.get((0, formula_1.normalizeRef)(ref)) ?? [])].sort();
    }
    /** Original formula text / literal for a cell, or undefined if empty. */
    formulaOf(ref) {
        const f = this.formulas.get((0, formula_1.normalizeRef)(ref));
        if (f === undefined)
            return undefined;
        return typeof f === "number" ? f : `=${(0, formula_1.exprToString)(f)}`;
    }
    beginTransaction() {
        this.snapshots.push({
            formulas: new Map(this.formulas),
            cache: new Map(this.cache),
            deps: copyGraph(this.deps),
            dependents: copyGraph(this.dependents),
        });
    }
    commit() {
        const snap = this.snapshots.pop();
        if (!snap)
            throw new Error("commit without beginTransaction");
    }
    /** Undo everything since beginTransaction: formulas, values and the dependency graph. */
    rollback() {
        const snap = this.snapshots.pop();
        if (!snap)
            throw new Error("rollback without beginTransaction");
        this.formulas = snap.formulas;
        this.cache = snap.cache;
        this.deps = snap.deps;
        this.dependents = snap.dependents;
    }
    /**
     * Independent full-table evaluation straight from the stored formulas,
     * bypassing the cache and dependency graph. Used to cross-check the
     * incremental engine.
     */
    evaluateAll() {
        const memo = new Map();
        const stack = [];
        const out = new Map();
        for (const cell of this.formulas.keys()) {
            try {
                out.set(cell, evaluateCell(this.formulas, cell, memo, stack));
            }
            catch (e) {
                if (e instanceof CycleError) {
                    out.set(cell, memo.get(cell));
                }
                else {
                    throw e;
                }
            }
        }
        return out;
    }
    trackRead = (dependent, dependency) => {
        let d = this.deps.get(dependent);
        if (!d)
            this.deps.set(dependent, (d = new Set()));
        d.add(dependency);
        let r = this.dependents.get(dependency);
        if (!r)
            this.dependents.set(dependency, (r = new Set()));
        r.add(dependent);
    };
    /**
     * Drop the cached value of `cell` and of everything that transitively
     * depends on it, and drop their recorded dependency edges so they are
     * re-tracked from scratch on next evaluation.
     */
    invalidate(root) {
        const queue = [root];
        const seen = new Set();
        while (queue.length > 0) {
            const cell = queue.pop();
            if (seen.has(cell))
                continue;
            seen.add(cell);
            this.cache.delete(cell);
            const myDeps = this.deps.get(cell);
            if (myDeps) {
                for (const d of myDeps)
                    this.dependents.get(d)?.delete(cell);
                this.deps.delete(cell);
            }
            const fans = this.dependents.get(cell);
            if (fans) {
                for (const f of fans)
                    queue.push(f);
                this.dependents.delete(cell);
            }
        }
    }
}
exports.Spreadsheet = Spreadsheet;
