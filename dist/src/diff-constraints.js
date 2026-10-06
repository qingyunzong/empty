"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DifferenceConstraints = void 0;
/**
 * Difference-constraint store over string variable aliases.
 *
 * Records constraints of the form `x - y = d` (bigint arithmetic) in a
 * weighted union-find without path compression, which keeps parent chains
 * intact so unions can be undone: `snapshot()` returns an opaque handle and
 * `rollback(handle)` restores the exact prior state.
 *
 * `query(x, y)` returns the implied difference, or `unknown` when the two
 * variables live in disconnected components (or were never constrained).
 * A contradicting `add` is rejected, leaves the store untouched, and
 * returns the evidence cycle that proves the conflict.
 */
class DifferenceConstraints {
    parent = new Map();
    /** weight[x] = x - parent[x] */
    weight = new Map();
    size = new Map();
    history = [];
    ensure(x) {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
            this.weight.set(x, 0n);
            this.size.set(x, 1);
        }
    }
    /** Root of x plus its potential: x - root. */
    find(x) {
        let pot = 0n;
        let cur = x;
        while (this.parent.get(cur) !== cur) {
            pot += this.weight.get(cur);
            cur = this.parent.get(cur);
        }
        return { root: cur, pot };
    }
    has(x) {
        return this.parent.has(x);
    }
    /** Record `x - y = diff`. Rejects contradictions without mutating state. */
    add(x, y, diff) {
        if (x === y) {
            // x - x is always 0; a non-zero self-constraint contradicts it.
            if (diff === 0n) {
                this.ensure(x);
                return { ok: true };
            }
            return {
                ok: false,
                reason: 'contradiction',
                implied: 0n,
                evidence: [{ from: x, to: x, diff: -diff }],
            };
        }
        if (this.parent.has(x) && this.parent.has(y)) {
            const fx = this.find(x);
            const fy = this.find(y);
            if (fx.root === fy.root) {
                const implied = fx.pot - fy.pot;
                if (implied === diff)
                    return { ok: true };
                return {
                    ok: false,
                    reason: 'contradiction',
                    implied,
                    evidence: this.evidenceCycle(x, y, diff),
                };
            }
        }
        this.ensure(x);
        this.ensure(y);
        const fx = this.find(x);
        const fy = this.find(y);
        const sx = this.size.get(fx.root);
        const sy = this.size.get(fy.root);
        if (sx >= sy) {
            // Attach fy.root under fx.root: need x - y = diff, i.e.
            // (fy.root - fx.root) = fx.pot - fy.pot - diff.
            this.parent.set(fy.root, fx.root);
            this.weight.set(fy.root, fx.pot - fy.pot - diff);
            this.size.set(fx.root, sx + sy);
            this.history.push({ child: fy.root, parent: fx.root, parentSize: sx });
        }
        else {
            // Attach fx.root under fy.root:
            // (fx.root - fy.root) = diff - fx.pot + fy.pot.
            this.parent.set(fx.root, fy.root);
            this.weight.set(fx.root, diff - fx.pot + fy.pot);
            this.size.set(fy.root, sx + sy);
            this.history.push({ child: fx.root, parent: fy.root, parentSize: sy });
        }
        return { ok: true };
    }
    query(x, y) {
        if (x === y)
            return { kind: 'known', diff: 0n };
        if (!this.parent.has(x) || !this.parent.has(y))
            return { kind: 'unknown' };
        const fx = this.find(x);
        const fy = this.find(y);
        if (fx.root !== fy.root)
            return { kind: 'unknown' };
        return { kind: 'known', diff: fx.pot - fy.pot };
    }
    /**
     * Opaque handle to the current state; pass to `rollback` later.
     * Rolling back past a snapshot invalidates its handle.
     */
    snapshot() {
        return this.history.length;
    }
    /** Undo every union recorded after `snap` was taken. */
    rollback(snap) {
        if (!Number.isInteger(snap) || snap < 0 || snap > this.history.length) {
            throw new RangeError(`invalid snapshot handle: ${snap}`);
        }
        while (this.history.length > snap) {
            const undo = this.history.pop();
            this.parent.set(undo.child, undo.child);
            this.weight.set(undo.child, 0n);
            this.size.set(undo.parent, undo.parentSize);
        }
    }
    /** Edges (cur, parent, cur - parent) from x up to its root. */
    chainToRoot(x) {
        const edges = [];
        let cur = x;
        while (this.parent.get(cur) !== cur) {
            const next = this.parent.get(cur);
            edges.push({ from: cur, to: next, diff: this.weight.get(cur) });
            cur = next;
        }
        return edges;
    }
    evidenceCycle(x, y, diff) {
        const up = this.chainToRoot(x);
        const down = this.chainToRoot(y)
            .reverse()
            .map((e) => ({ from: e.to, to: e.from, diff: -e.diff }));
        return [...up, ...down, { from: y, to: x, diff: -diff }];
    }
}
exports.DifferenceConstraints = DifferenceConstraints;
