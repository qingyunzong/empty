import { InfeasibleError, splitDetailed, } from "./split.js";
/**
 * Multi-order split ledger.
 *
 * Every recipient has global [min, max] bounds that apply to its cumulative
 * share across all active orders.  Adding or refunding an order re-splits the
 * full active total: a refund undoes the refunded order's contribution and
 * the remaining amount is re-allocated among the *unlocked* recipients.
 * Locked recipients keep their frozen amount untouched.
 *
 * Any operation that would make the constraints unsatisfiable throws
 * InfeasibleError and leaves the ledger unchanged.
 */
export class SplitLedger {
    recipients;
    orders = new Map();
    locked = new Map();
    allocation = new Map();
    constructor(recipients, orders = []) {
        if (recipients.length === 0) {
            throw new Error("at least one recipient is required");
        }
        this.recipients = recipients.map((r) => ({ ...r }));
        for (const o of orders)
            this.addOrderInternal(o.id, o.amount);
        this.recompute();
    }
    /** Sum of the amounts of all active (non-refunded) orders. */
    get totalActive() {
        let sum = 0;
        for (const a of this.orders.values())
            sum += a;
        return sum;
    }
    get activeOrderIds() {
        return [...this.orders.keys()];
    }
    isLocked(id) {
        return this.locked.has(id);
    }
    /** Current cumulative share per recipient (sorted by ID). */
    getAllocation() {
        return new Map(this.allocation);
    }
    getAllocationDetailed() {
        return [...this.allocation.entries()]
            .map(([id, amount]) => ({ id, amount }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    addOrder(id, amount) {
        this.addOrderInternal(id, amount);
        try {
            this.recompute();
        }
        catch (err) {
            this.orders.delete(id);
            throw err;
        }
        return this.getAllocation();
    }
    /**
     * Refund an order: its allocation is undone and the remaining active total
     * is re-split among unlocked recipients.  Locked amounts do not move; if
     * they no longer fit the remaining total, InfeasibleError is thrown and
     * the refund is rolled back.
     */
    refund(orderId) {
        const amount = this.orders.get(orderId);
        if (amount === undefined) {
            throw new Error(`unknown order: ${orderId}`);
        }
        this.orders.delete(orderId);
        try {
            this.recompute();
        }
        catch (err) {
            this.orders.set(orderId, amount);
            throw err;
        }
        return this.getAllocation();
    }
    /** Freeze the recipient's current cumulative share. */
    lock(id) {
        if (!this.recipients.some((r) => r.id === id)) {
            throw new Error(`unknown recipient: ${String(id)}`);
        }
        if (this.locked.has(id)) {
            throw new Error(`recipient already locked: ${String(id)}`);
        }
        this.locked.set(id, this.allocation.get(id) ?? 0);
    }
    unlock(id) {
        const frozen = this.locked.get(id);
        if (frozen === undefined) {
            throw new Error(`recipient not locked: ${String(id)}`);
        }
        this.locked.delete(id);
        try {
            this.recompute();
        }
        catch (err) {
            this.locked.set(id, frozen);
            throw err;
        }
        return this.getAllocation();
    }
    addOrderInternal(id, amount) {
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new Error(`order amount must be a positive integer, got ${amount}`);
        }
        if (this.orders.has(id)) {
            throw new Error(`duplicate order id: ${id}`);
        }
        this.orders.set(id, amount);
    }
    recompute() {
        const total = this.totalActive;
        let lockedSum = 0;
        for (const v of this.locked.values())
            lockedSum += v;
        if (total === 0 && lockedSum === 0) {
            // Nothing to split yet: everyone holds zero.
            this.allocation = new Map(this.recipients.map((r) => [r.id, 0]));
            return;
        }
        if (lockedSum > total) {
            throw new InfeasibleError(`locked amount (${lockedSum}) exceeds active order total (${total})`);
        }
        const unlocked = this.recipients.filter((r) => !this.locked.has(r.id));
        const shares = splitDetailed(total - lockedSum, unlocked);
        const next = new Map();
        for (const [id, amount] of this.locked)
            next.set(id, amount);
        for (const s of shares)
            next.set(s.id, s.amount);
        this.allocation = next;
    }
}
