import { type AllocationEntry, type Recipient } from "./split.js";
export interface Order {
    id: string;
    amount: number;
}
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
export declare class SplitLedger {
    private readonly recipients;
    private readonly orders;
    private readonly locked;
    private allocation;
    constructor(recipients: Recipient[], orders?: Order[]);
    /** Sum of the amounts of all active (non-refunded) orders. */
    get totalActive(): number;
    get activeOrderIds(): string[];
    isLocked(id: string | number): boolean;
    /** Current cumulative share per recipient (sorted by ID). */
    getAllocation(): Map<string | number, number>;
    getAllocationDetailed(): AllocationEntry[];
    addOrder(id: string, amount: number): Map<string | number, number>;
    /**
     * Refund an order: its allocation is undone and the remaining active total
     * is re-split among unlocked recipients.  Locked amounts do not move; if
     * they no longer fit the remaining total, InfeasibleError is thrown and
     * the refund is rolled back.
     */
    refund(orderId: string): Map<string | number, number>;
    /** Freeze the recipient's current cumulative share. */
    lock(id: string | number): void;
    unlock(id: string | number): Map<string | number, number>;
    private addOrderInternal;
    private recompute;
}
