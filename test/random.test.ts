import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetError, BudgetSystem, type TransferOp } from "../src/budget.js";

/** Deterministic PRNG (mulberry32) so every random history is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelSpend {
  tokenId: string;
  amount: number;
  refunded: boolean;
}

/**
 * Independent model of the operation history. It tracks only the tree
 * shape and the spend ledger; conservation and per-token consumption are
 * derived from it and cross-checked against the real system after every op.
 */
class Model {
  readonly parent = new Map<string, string | null>();
  readonly active = new Map<string, boolean>();
  readonly consumed = new Map<string, number>();
  readonly spends = new Map<string, ModelSpend>();
  initialQuota = 0;

  addRoot(id: string, quota: number): void {
    this.parent.set(id, null);
    this.active.set(id, true);
    this.consumed.set(id, 0);
    this.initialQuota += quota;
  }

  addChild(parentId: string, childId: string): void {
    this.parent.set(childId, parentId);
    this.active.set(childId, true);
    this.consumed.set(childId, 0);
  }

  netConsumedTotal(): number {
    let total = 0;
    for (const spend of this.spends.values()) {
      if (!spend.refunded) total += spend.amount;
    }
    return total;
  }

  /** Expected total consumption of every subtree, in one O(tokens * depth) pass. */
  subtreeConsumedTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const id of this.consumed.keys()) totals.set(id, 0);
    for (const [id, consumed] of this.consumed) {
      let cursor: string | null = id;
      while (cursor !== null) {
        totals.set(cursor, (totals.get(cursor) ?? 0) + consumed);
        cursor = this.parent.get(cursor) ?? null;
      }
    }
    return totals;
  }
}

function checkAgainstModel(sys: BudgetSystem, model: Model): void {
  let totalAvailable = 0;
  for (const id of sys.tokenIds()) {
    const available = sys.getAvailable(id);
    assert.ok(available >= 0, `negative available on ${id}: ${available}`);
    totalAvailable += available;
    assert.equal(sys.getConsumed(id), model.consumed.get(id), `own consumed mismatch on ${id}`);
  }
  const expectedSubtreeTotals = model.subtreeConsumedTotals();
  for (const id of sys.tokenIds()) {
    assert.equal(
      sys.getTotalConsumed(id),
      expectedSubtreeTotals.get(id),
      `subtree consumption mismatch on ${id}`,
    );
  }
  assert.equal(
    totalAvailable + model.netConsumedTotal(),
    model.initialQuota,
    "conservation violated: available + consumed != initial quota",
  );
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function runRandomHistory(seed: number, opCount: number): void {
  const rand = mulberry32(seed);
  const sys = new BudgetSystem();
  const model = new Model();
  const int = (n: number): number => 1 + Math.floor(rand() * n);

  sys.createRoot("root", 100_000);
  model.addRoot("root", 100_000);
  let tokenSeq = 0;

  const activeTokens = (): string[] => sys.tokenIds().filter((id) => sys.isActive(id));

  for (let step = 0; step < opCount; step++) {
    const roll = rand();
    const active = activeTokens();

    if (roll < 0.25 && sys.tokenIds().length < 300) {
      // grant: parent splits quota to a new child
      const parent = pick(rand, active);
      const parentAvailable = sys.getAvailable(parent);
      if (parentAvailable < 1) continue;
      const childId = `t${++tokenSeq}`;
      sys.grant(parent, childId, int(parentAvailable));
      model.addChild(parent, childId);
    } else if (roll < 0.55) {
      // spend from a random active token
      const id = pick(rand, active);
      const available = sys.getAvailable(id);
      if (available < 1) continue;
      const amount = int(available);
      const spendId = sys.spend(id, amount);
      model.spends.set(spendId, { tokenId: id, amount, refunded: false });
      model.consumed.set(id, (model.consumed.get(id) ?? 0) + amount);
    } else if (roll < 0.67) {
      // refund a random unrefunded spend; sometimes probe invalid refunds
      const unrefunded = [...model.spends.entries()].filter(([, s]) => !s.refunded);
      if (rand() < 0.15) {
        const refundedIds = [...model.spends.entries()].filter(([, s]) => s.refunded).map(([id]) => id);
        const bogusId = refundedIds.length > 0 && rand() < 0.5 ? pick(rand, refundedIds) : "spend-bogus";
        assert.throws(() => sys.refund(bogusId), BudgetError, `refund of ${bogusId} must fail`);
        continue;
      }
      if (unrefunded.length === 0) continue;
      const [spendId, spend] = pick(rand, unrefunded);
      sys.refund(spendId);
      spend.refunded = true;
      model.consumed.set(spend.tokenId, (model.consumed.get(spend.tokenId) ?? 0) - spend.amount);
    } else if (roll < 0.75) {
      // revoke a random non-root token; sometimes probe double revoke
      const revocable = active.filter((id) => id !== "root");
      if (revocable.length === 0) continue;
      const id = pick(rand, revocable);
      const expectedReturn = sys.getAvailable(id);
      assert.equal(sys.revoke(id), expectedReturn, "revoke must return the unused quota");
      model.active.set(id, false);
      if (rand() < 0.3) {
        assert.throws(() => sys.revoke(id), BudgetError, "double revoke must fail");
      }
    } else if (roll < 0.85) {
      // single transfer between distinct active tokens
      if (active.length < 2) continue;
      const from = pick(rand, active);
      const to = pick(rand, active.filter((id) => id !== from));
      const available = sys.getAvailable(from);
      if (available < 1) continue;
      sys.transfer(from, to, int(available));
    } else {
      // atomic batch transfer; sometimes inject a failing op
      if (active.length < 2) continue;
      const ops: TransferOp[] = [];
      const opCount = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < opCount; i++) {
        const from = pick(rand, active);
        const to = pick(rand, active.filter((id) => id !== from));
        ops.push({ from, to, amount: int(50) });
      }
      if (rand() < 0.35) {
        const victim = pick(rand, active);
        ops.push({ from: victim, to: pick(rand, active.filter((id) => id !== victim)), amount: sys.getAvailable(victim) + int(1000) });
        const snapshot = new Map(sys.tokenIds().map((id) => [id, sys.getAvailable(id)]));
        assert.throws(() => sys.transferBatch(ops), BudgetError, "poisoned batch must fail");
        for (const [id, balance] of snapshot) {
          assert.equal(sys.getAvailable(id), balance, `batch not atomic: ${id} changed`);
        }
        continue;
      }
      try {
        sys.transferBatch(ops);
      } catch (err) {
        // random valid-shaped batches may still overflow a balance; that is
        // fine as long as the failure is atomic
        assert.ok(err instanceof BudgetError);
        const snapshotTotal = [...model.consumed.keys()].reduce((sum, id) => sum + sys.getAvailable(id), 0);
        assert.equal(snapshotTotal + model.netConsumedTotal(), model.initialQuota);
      }
    }

    checkAgainstModel(sys, model);
  }

  // final full audit: spend records match the model ledger exactly
  for (const [spendId, spend] of model.spends) {
    const rec = sys.getSpend(spendId);
    assert.ok(rec !== undefined, `missing spend record ${spendId}`);
    assert.equal(rec.tokenId, spend.tokenId);
    assert.equal(rec.amount, spend.amount);
    assert.equal(rec.refunded, spend.refunded);
  }
  checkAgainstModel(sys, model);
}

const SEEDS = [1, 2, 3, 7, 42, 99, 2024, 31337];

for (const seed of SEEDS) {
  test(`random tree history conserves quota (seed=${seed})`, () => {
    runRandomHistory(seed, 1500);
  });
}
