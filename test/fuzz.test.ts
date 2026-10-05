import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetLedger } from "../src/budget.js";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelToken {
  parentId: string | null;
  quota: number;
  consumed: number;
  totalConsumed: number;
  revoked: boolean;
  children: string[];
}

/**
 * Independent reference model of the ledger, written directly from the spec.
 * The fuzz test drives both with identical random histories and requires
 * them to agree on success/failure and on every observable field.
 */
class Model {
  tokens = new Map<string, ModelToken>();
  consumptions = new Map<string, { tokenId: string; amount: number; refunded: boolean }>();
  rootQuota: number;

  constructor(rootQuota: number) {
    this.rootQuota = rootQuota;
    this.tokens.set("root", {
      parentId: null,
      quota: rootQuota,
      consumed: 0,
      totalConsumed: 0,
      revoked: false,
      children: [],
    });
  }

  private active(id: string): ModelToken {
    const t = this.tokens.get(id);
    if (!t || t.revoked) throw new Error("inactive");
    return t;
  }

  private bump(id: string, delta: number): void {
    let cur: string | null = id;
    while (cur !== null) {
      const t: ModelToken = this.tokens.get(cur)!;
      t.totalConsumed += delta;
      cur = t.parentId;
    }
  }

  allocate(parentId: string, childId: string, amount: number): void {
    const parent = this.active(parentId);
    if (this.tokens.has(childId)) throw new Error("exists");
    if (parent.quota < amount) throw new Error("insufficient");
    parent.quota -= amount;
    this.tokens.set(childId, {
      parentId,
      quota: amount,
      consumed: 0,
      totalConsumed: 0,
      revoked: false,
      children: [],
    });
    parent.children.push(childId);
  }

  consume(tokenId: string, amount: number, cid: string): void {
    const t = this.active(tokenId);
    if (this.consumptions.has(cid)) throw new Error("dup");
    if (t.quota < amount) throw new Error("insufficient");
    t.quota -= amount;
    t.consumed += amount;
    this.bump(tokenId, amount);
    this.consumptions.set(cid, { tokenId, amount, refunded: false });
  }

  refund(cid: string): void {
    const r = this.consumptions.get(cid);
    if (!r) throw new Error("unknown");
    if (r.refunded) throw new Error("refunded");
    const t = this.tokens.get(r.tokenId)!;
    if (t.revoked) throw new Error("revoked");
    r.refunded = true;
    t.quota += r.amount;
    t.consumed -= r.amount;
    this.bump(r.tokenId, -r.amount);
  }

  revoke(id: string): void {
    const t = this.tokens.get(id);
    if (!t) throw new Error("unknown");
    if (t.parentId === null) throw new Error("root");
    if (t.revoked) throw new Error("revoked");
    let returned = 0;
    const stack = [id];
    while (stack.length) {
      const cur = this.tokens.get(stack.pop()!)!;
      returned += cur.quota;
      cur.quota = 0;
      cur.revoked = true;
      stack.push(...cur.children);
    }
    const parent = this.tokens.get(t.parentId)!;
    parent.children = parent.children.filter((c) => c !== id);
    parent.quota += returned;
  }

  transferBatch(ts: { from: string; to: string; amount: number }[]): void {
    const deltas = new Map<string, number>();
    for (const { from, to, amount } of ts) {
      if (from === to) throw new Error("self");
      this.active(from);
      this.active(to);
      deltas.set(from, (deltas.get(from) ?? 0) - amount);
      deltas.set(to, (deltas.get(to) ?? 0) + amount);
    }
    for (const [id, d] of deltas) {
      if (this.tokens.get(id)!.quota + d < 0) throw new Error("insufficient");
    }
    for (const [id, d] of deltas) this.tokens.get(id)!.quota += d;
  }
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function runHistory(seed: number, ops: number): void {
  const rand = rng(seed);
  const rootQuota = 1_000_000;
  const ledger = new BudgetLedger();
  ledger.createRoot("root", rootQuota);
  const model = new Model(rootQuota);

  const ids: string[] = ["root"];
  const cids: string[] = [];
  let nextToken = 0;
  let nextCid = 0;

  const both = (fn: (target: BudgetLedger | Model) => void): void => {
    let ledgerErr: unknown = null;
    let modelErr: unknown = null;
    try {
      fn(ledger);
    } catch (e) {
      ledgerErr = e;
    }
    try {
      fn(model);
    } catch (e) {
      modelErr = e;
    }
    assert.equal(
      ledgerErr === null,
      modelErr === null,
      `seed ${seed}: ledger/model disagree on failure (ledger: ${ledgerErr}, model: ${modelErr})`,
    );
  };

  for (let step = 0; step < ops; step++) {
    const op = Math.floor(rand() * 5);
    if (op === 0) {
      const parent = pick(rand, ids);
      const child = `t${nextToken++}`;
      const amount = 1 + Math.floor(rand() * 5000);
      both((t) => t.allocate(parent, child, amount));
      if (ledger.has(child)) ids.push(child);
    } else if (op === 1) {
      const id = pick(rand, ids);
      const cid = `c${nextCid++}`;
      const amount = 1 + Math.floor(rand() * 2000);
      both((t) => t.consume(id, amount, cid));
      cids.push(cid);
    } else if (op === 2 && cids.length > 0) {
      const cid = pick(rand, cids);
      both((t) => t.refund(cid));
    } else if (op === 3 && ids.length > 1) {
      const id = pick(rand, ids.slice(1));
      both((t) => t.revoke(id));
    } else {
      const n = 1 + Math.floor(rand() * 4);
      const ts = Array.from({ length: n }, () => ({
        from: pick(rand, ids),
        to: pick(rand, ids),
        amount: 1 + Math.floor(rand() * 3000),
      }));
      both((t) => t.transferBatch(ts));
    }
  }

  // Full state equality between ledger and model.
  for (const [id, m] of model.tokens) {
    const v = ledger.get(id);
    assert.equal(v.quota, m.quota, `seed ${seed} ${id} quota`);
    assert.equal(v.consumed, m.consumed, `seed ${seed} ${id} consumed`);
    assert.equal(v.totalConsumed, m.totalConsumed, `seed ${seed} ${id} totalConsumed`);
    assert.equal(v.revoked, m.revoked, `seed ${seed} ${id} revoked`);
    assert.ok(v.quota >= 0, `seed ${seed} ${id} negative quota`);
  }

  // Conservation: remaining quota everywhere + net consumption = initial pool.
  assert.equal(
    ledger.conservedTotal(),
    rootQuota,
    `seed ${seed}: conservation violated`,
  );
}

test("random tree histories match reference model and conserve budget", () => {
  for (let seed = 1; seed <= 40; seed++) {
    runHistory(seed, 400);
  }
});
