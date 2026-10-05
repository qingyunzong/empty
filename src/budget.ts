/**
 * Hierarchical budget ledger.
 *
 * - A root token is created with an initial quota (budget pool).
 * - A parent token allocates part of its remaining quota to a child token.
 * - Consuming on a token deducts its own remaining quota and is recorded in
 *   every ancestor's `totalConsumed` (so the parent/root sees the rollup).
 * - A refund restores a previous consumption exactly once, matched by the
 *   original consumption id.
 * - Revoking a token returns its (and its subtree's) unused quota to its parent.
 * - Batch transfers are atomic: either every transfer applies or none do.
 *
 * All amounts are non-negative integers (smallest currency unit).
 */

export type TokenId = string;
export type ConsumptionId = string;

export interface TokenView {
  readonly id: TokenId;
  readonly parentId: TokenId | null;
  /** Remaining allocatable/spendable quota. */
  readonly quota: number;
  /** Total consumed directly by this token (net of refunds). */
  readonly consumed: number;
  /** Total consumed by this token and its whole subtree (net of refunds). */
  readonly totalConsumed: number;
  readonly revoked: boolean;
}

interface TokenState {
  id: TokenId;
  parentId: TokenId | null;
  quota: number;
  consumed: number;
  totalConsumed: number;
  revoked: boolean;
  children: Set<TokenId>;
}

interface ConsumptionRecord {
  id: ConsumptionId;
  tokenId: TokenId;
  amount: number;
  refunded: boolean;
}

export interface Transfer {
  from: TokenId;
  to: TokenId;
  amount: number;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

function assertAmount(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BudgetError(`${what} must be a positive safe integer, got ${amount}`);
  }
}

export class BudgetLedger {
  private tokens = new Map<TokenId, TokenState>();
  private consumptions = new Map<ConsumptionId, ConsumptionRecord>();

  /** Create the root token with the initial budget pool. */
  createRoot(id: TokenId, quota: number): void {
    if (this.tokens.size > 0) throw new BudgetError("root token already exists");
    if (!Number.isSafeInteger(quota) || quota < 0) {
      throw new BudgetError(`root quota must be a non-negative safe integer, got ${quota}`);
    }
    this.addToken(id, null, quota);
  }

  /** Parent allocates `amount` of its remaining quota to a new child token. */
  allocate(parentId: TokenId, childId: TokenId, amount: number): void {
    const parent = this.requireActive(parentId);
    assertAmount(amount, "allocation amount");
    if (this.tokens.has(childId)) throw new BudgetError(`token already exists: ${childId}`);
    if (parent.quota < amount) {
      throw new BudgetError(
        `insufficient quota on ${parentId}: have ${parent.quota}, need ${amount}`,
      );
    }
    parent.quota -= amount;
    this.addToken(childId, parentId, amount);
  }

  /**
   * Consume `amount` from a token: deducts its remaining quota and records the
   * amount in `totalConsumed` of the token and every ancestor.
   * `consumptionId` must be unique; it is the handle for a later refund.
   */
  consume(tokenId: TokenId, amount: number, consumptionId: ConsumptionId): void {
    const token = this.requireActive(tokenId);
    assertAmount(amount, "consumption amount");
    if (this.consumptions.has(consumptionId)) {
      throw new BudgetError(`duplicate consumption id: ${consumptionId}`);
    }
    if (token.quota < amount) {
      throw new BudgetError(
        `insufficient quota on ${tokenId}: have ${token.quota}, need ${amount}`,
      );
    }
    token.quota -= amount;
    token.consumed += amount;
    this.addToAncestorTotals(token, amount);
    this.consumptions.set(consumptionId, {
      id: consumptionId,
      tokenId,
      amount,
      refunded: false,
    });
  }

  /**
   * Refund a previous consumption, matched by its original id.
   * Each consumption id can be refunded at most once.
   */
  refund(consumptionId: ConsumptionId): void {
    const record = this.consumptions.get(consumptionId);
    if (!record) throw new BudgetError(`unknown consumption id: ${consumptionId}`);
    if (record.refunded) {
      throw new BudgetError(`consumption already refunded: ${consumptionId}`);
    }
    const token = this.tokens.get(record.tokenId);
    if (!token || token.revoked) {
      throw new BudgetError(`cannot refund to revoked token: ${record.tokenId}`);
    }
    record.refunded = true;
    token.quota += record.amount;
    token.consumed -= record.amount;
    this.addToAncestorTotals(token, -record.amount);
  }

  /**
   * Revoke a token: the unused quota of the token and its whole subtree is
   * returned to its parent. The subtree is marked revoked and can no longer
   * allocate, consume, or be refunded into.
   */
  revoke(tokenId: TokenId): void {
    const token = this.tokens.get(tokenId);
    if (!token) throw new BudgetError(`unknown token: ${tokenId}`);
    if (token.parentId === null) throw new BudgetError("cannot revoke the root token");
    if (token.revoked) throw new BudgetError(`token already revoked: ${tokenId}`);
    const returned = this.subtreeQuota(tokenId);
    for (const id of this.subtreeIds(tokenId)) {
      const t = this.tokens.get(id)!;
      t.revoked = true;
      t.quota = 0;
    }
    const parent = this.tokens.get(token.parentId)!;
    parent.children.delete(tokenId);
    parent.quota += returned;
  }

  /**
   * Apply a batch of quota transfers atomically: every transfer is validated
   * first; if any fails, no transfer is applied.
   */
  transferBatch(transfers: readonly Transfer[]): void {
    // Validation phase (no mutation).
    const deltas = new Map<TokenId, number>();
    for (const t of transfers) {
      assertAmount(t.amount, "transfer amount");
      if (t.from === t.to) throw new BudgetError(`self-transfer: ${t.from}`);
      this.requireActive(t.from);
      this.requireActive(t.to);
      deltas.set(t.from, (deltas.get(t.from) ?? 0) - t.amount);
      deltas.set(t.to, (deltas.get(t.to) ?? 0) + t.amount);
    }
    for (const [id, delta] of deltas) {
      const token = this.tokens.get(id)!;
      if (token.quota + delta < 0) {
        throw new BudgetError(
          `insufficient quota on ${id}: have ${token.quota}, net change ${delta}`,
        );
      }
    }
    // Apply phase (cannot fail).
    for (const [id, delta] of deltas) {
      this.tokens.get(id)!.quota += delta;
    }
  }

  /** Read-only view of a token. */
  get(tokenId: TokenId): TokenView {
    const t = this.tokens.get(tokenId);
    if (!t) throw new BudgetError(`unknown token: ${tokenId}`);
    return {
      id: t.id,
      parentId: t.parentId,
      quota: t.quota,
      consumed: t.consumed,
      totalConsumed: t.totalConsumed,
      revoked: t.revoked,
    };
  }

  has(tokenId: TokenId): boolean {
    return this.tokens.has(tokenId);
  }

  /**
   * Conservation check: sum of all remaining quotas plus the root's
   * totalConsumed must equal the initial root quota.
   */
  conservedTotal(): number {
    let sum = 0;
    for (const t of this.tokens.values()) sum += t.quota;
    const root = [...this.tokens.values()].find((t) => t.parentId === null);
    return sum + (root ? root.totalConsumed : 0);
  }

  private addToken(id: TokenId, parentId: TokenId | null, quota: number): void {
    if (this.tokens.has(id)) throw new BudgetError(`token already exists: ${id}`);
    this.tokens.set(id, {
      id,
      parentId,
      quota,
      consumed: 0,
      totalConsumed: 0,
      revoked: false,
      children: new Set(),
    });
    if (parentId !== null) this.tokens.get(parentId)!.children.add(id);
  }

  private requireActive(id: TokenId): TokenState {
    const t = this.tokens.get(id);
    if (!t) throw new BudgetError(`unknown token: ${id}`);
    if (t.revoked) throw new BudgetError(`token revoked: ${id}`);
    return t;
  }

  private addToAncestorTotals(token: TokenState, delta: number): void {
    let cur: TokenState | undefined = token;
    while (cur) {
      cur.totalConsumed += delta;
      cur = cur.parentId === null ? undefined : this.tokens.get(cur.parentId);
    }
  }

  private subtreeIds(rootId: TokenId): TokenId[] {
    const out: TokenId[] = [];
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      const t = this.tokens.get(id)!;
      for (const child of t.children) stack.push(child);
    }
    return out;
  }

  private subtreeQuota(rootId: TokenId): number {
    let sum = 0;
    for (const id of this.subtreeIds(rootId)) sum += this.tokens.get(id)!.quota;
    return sum;
  }
}
