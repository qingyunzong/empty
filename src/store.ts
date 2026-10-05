/**
 * Transactional ledger with idempotency: the dedup check (by message id) and
 * the business effect commit in the same transaction. An injected commit
 * failure rolls back both, so a redelivered message is retried cleanly.
 */
export class LedgerStore {
  private applied = new Set<string>();
  private balances = new Map<string, number>();

  /** Fault injection hook: throw to simulate a commit failure (full rollback). */
  beforeCommit: ((messageId: string) => void) | null = null;

  balanceOf(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  appliedCount(): number {
    return this.applied.size;
  }

  /** Returns true if the effect was applied, false if the id was already done. */
  applyTransfer(messageId: string, account: string, amount: number): boolean {
    if (this.applied.has(messageId)) return false; // duplicate delivery: dedup, no effect
    const nextBalance = this.balanceOf(account) + amount; // staged, not yet visible
    if (this.beforeCommit) this.beforeCommit(messageId); // throws -> rollback, nothing persists
    this.applied.add(messageId);
    this.balances.set(account, nextBalance);
    return true;
  }
}
