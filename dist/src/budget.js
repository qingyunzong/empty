/**
 * Hierarchical authorization budget library.
 *
 * A forest of tokens. Each root token is created with an initial quota.
 * A parent token grants part of its quota to a child token. Spending
 * deducts from the spending token's quota and is recorded in every
 * ancestor's total consumption. A refund is tied to the original spend
 * id and may happen at most once. Revoking a child returns its unused
 * quota to its parent. Batch quota transfers are atomic.
 *
 * Amounts are positive safe integers (quota units), so conservation is
 * exact: sum(available over all tokens) + sum(net consumed) === sum(root quotas).
 */
export class BudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "BudgetError";
    }
}
function checkAmount(amount, what) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new BudgetError(`${what} must be a positive safe integer, got ${amount}`);
    }
}
export class BudgetSystem {
    tokens = new Map();
    spends = new Map();
    spendSeq = 0;
    /** Create a root token with an initial quota. Multiple roots (a forest) are allowed. */
    createRoot(id, quota) {
        if (!Number.isSafeInteger(quota) || quota < 0) {
            throw new BudgetError(`quota must be a non-negative safe integer, got ${quota}`);
        }
        if (this.tokens.has(id)) {
            throw new BudgetError(`token "${id}" already exists`);
        }
        this.tokens.set(id, { id, parentId: null, available: quota, consumed: 0, active: true, children: [] });
    }
    /** Parent grants `amount` of its own quota to a new child token. */
    grant(parentId, childId, amount) {
        const parent = this.requireActive(parentId);
        checkAmount(amount, "grant amount");
        if (this.tokens.has(childId)) {
            throw new BudgetError(`token "${childId}" already exists`);
        }
        if (parent.available < amount) {
            throw new BudgetError(`insufficient quota on "${parentId}": have ${parent.available}, need ${amount}`);
        }
        parent.available -= amount;
        this.tokens.set(childId, { id: childId, parentId, available: amount, consumed: 0, active: true, children: [] });
        parent.children.push(childId);
    }
    /**
     * Spend `amount` from a token's quota. Deducts the token's available quota
     * and records the consumption so every ancestor's total consumption
     * reflects it. Returns the unique spend id (needed for refund).
     */
    spend(tokenId, amount) {
        const token = this.requireActive(tokenId);
        checkAmount(amount, "spend amount");
        if (token.available < amount) {
            throw new BudgetError(`insufficient quota on "${tokenId}": have ${token.available}, need ${amount}`);
        }
        token.available -= amount;
        token.consumed += amount;
        const id = `spend-${++this.spendSeq}`;
        this.spends.set(id, { id, tokenId, amount, refunded: false });
        return id;
    }
    /**
     * Refund a spend. Only the original spend id is accepted, and each spend
     * may be refunded at most once. The amount is credited back to the
     * spender, or — if the spender has been revoked — to the nearest active
     * ancestor (which is where its quota went on revocation).
     */
    refund(spendId) {
        const rec = this.spends.get(spendId);
        if (rec === undefined) {
            throw new BudgetError(`unknown spend id "${spendId}"`);
        }
        if (rec.refunded) {
            throw new BudgetError(`spend "${spendId}" was already refunded`);
        }
        rec.refunded = true;
        const spender = this.tokens.get(rec.tokenId);
        if (spender === undefined) {
            throw new BudgetError(`spender token "${rec.tokenId}" no longer exists`);
        }
        spender.consumed -= rec.amount;
        let node = spender;
        while (!node.active && node.parentId !== null) {
            const parent = this.tokens.get(node.parentId);
            if (parent === undefined) {
                throw new BudgetError(`broken tree: missing parent "${node.parentId}"`);
            }
            node = parent;
        }
        node.available += rec.amount;
    }
    /**
     * Revoke a child token: it becomes inactive and its unused quota is
     * returned to its parent. The root cannot be revoked. Already-consumed
     * quota stays consumed. Children of the revoked token are unaffected.
     * Returns the amount of unused quota given back.
     */
    revoke(tokenId) {
        const token = this.tokens.get(tokenId);
        if (token === undefined) {
            throw new BudgetError(`unknown token "${tokenId}"`);
        }
        if (token.parentId === null) {
            throw new BudgetError(`cannot revoke root token "${tokenId}"`);
        }
        if (!token.active) {
            throw new BudgetError(`token "${tokenId}" is already revoked`);
        }
        token.active = false;
        const parent = this.tokens.get(token.parentId);
        if (parent === undefined) {
            throw new BudgetError(`broken tree: missing parent "${token.parentId}"`);
        }
        const returned = token.available;
        parent.available += returned;
        token.available = 0;
        return returned;
    }
    /** Move quota between two active tokens. */
    transfer(from, to, amount) {
        this.transferBatch([{ from, to, amount }]);
    }
    /**
     * Apply a batch of quota transfers atomically: either every transfer in
     * the batch is applied, or (if any validation fails) none of them are.
     * Transfers are applied in order, so later transfers may spend quota
     * received by earlier ones in the same batch.
     */
    transferBatch(ops) {
        // Phase 1: validate and simulate on a scratch copy of the balances.
        const balances = new Map();
        const load = (id) => {
            const cached = balances.get(id);
            if (cached !== undefined)
                return cached;
            const balance = this.requireActive(id).available;
            balances.set(id, balance);
            return balance;
        };
        for (const op of ops) {
            checkAmount(op.amount, "transfer amount");
            if (op.from === op.to) {
                throw new BudgetError(`self transfer on "${op.from}" is not allowed`);
            }
            load(op.from);
            load(op.to);
        }
        for (const op of ops) {
            const fromBalance = balances.get(op.from);
            const toBalance = balances.get(op.to);
            if (fromBalance === undefined || toBalance === undefined) {
                throw new BudgetError("broken batch state");
            }
            if (fromBalance < op.amount) {
                throw new BudgetError(`insufficient quota on "${op.from}" in batch: have ${fromBalance}, need ${op.amount}`);
            }
            balances.set(op.from, fromBalance - op.amount);
            balances.set(op.to, toBalance + op.amount);
        }
        // Phase 2: commit. Nothing below can throw, so the batch is atomic.
        for (const [id, balance] of balances) {
            const token = this.tokens.get(id);
            if (token === undefined) {
                throw new BudgetError(`broken tree: missing token "${id}"`);
            }
            token.available = balance;
        }
    }
    /** Available (unspent, ungranted) quota of a token. */
    getAvailable(tokenId) {
        return this.requireToken(tokenId).available;
    }
    /** Net consumption recorded directly on a token (excludes descendants). */
    getConsumed(tokenId) {
        return this.requireToken(tokenId).consumed;
    }
    /** Net consumption of a token plus its whole subtree (the parent's total consumption). */
    getTotalConsumed(tokenId) {
        const token = this.requireToken(tokenId);
        let total = token.consumed;
        for (const childId of token.children) {
            total += this.getTotalConsumed(childId);
        }
        return total;
    }
    /** Sum of available quota over all tokens (revoked tokens hold zero). */
    totalAvailable() {
        let total = 0;
        for (const token of this.tokens.values()) {
            total += token.available;
        }
        return total;
    }
    /** Look up a spend record by id (undefined if unknown). */
    getSpend(spendId) {
        return this.spends.get(spendId);
    }
    isActive(tokenId) {
        return this.requireToken(tokenId).active;
    }
    parentOf(tokenId) {
        return this.requireToken(tokenId).parentId;
    }
    tokenIds() {
        return [...this.tokens.keys()];
    }
    requireToken(tokenId) {
        const token = this.tokens.get(tokenId);
        if (token === undefined) {
            throw new BudgetError(`unknown token "${tokenId}"`);
        }
        return token;
    }
    requireActive(tokenId) {
        const token = this.requireToken(tokenId);
        if (!token.active) {
            throw new BudgetError(`token "${tokenId}" is revoked`);
        }
        return token;
    }
}
