import { test } from "node:test";
import assert from "node:assert/strict";
import { Unifier, type Constraint } from "../src/unifier.js";
import { oracleUnify, oracleExpand, expansionHolds } from "../src/oracle.js";
import { mulberry32, randomConstraints } from "../src/random.js";
import { tvar, typeEquals, showType } from "../src/types.js";

const SPEC = { varCount: 5, maxDepth: 3 } as const;
const SEEDS = 400;

test("random constraints: main unifier agrees with no-cache oracle", () => {
  let accepted = 0;
  let rejected = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const count = 1 + Math.floor(rand() * 8);
    const raws = randomConstraints(rand, count, SPEC);

    // Feed constraints one by one into the main unifier, stopping at first failure.
    const u = new Unifier();
    const kept: Constraint[] = [];
    let failedAt: number | null = null;
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i]!;
      const res = u.add(raw.name, raw.left, raw.right);
      if (res.ok) {
        kept.push({ id: res.id, name: raw.name, left: raw.left, right: raw.right });
      } else {
        failedAt = i;
        // Cross-check the failure: oracle must reject kept + new constraint too.
        const failing = [
          ...kept,
          { id: kept.length + 1, name: raw.name, left: raw.left, right: raw.right },
        ];
        const oracle = oracleUnify(failing);
        assert.equal(oracle.ok, false, `seed=${seed} i=${i}: oracle accepted a rejected set`);
        // Conflict chain must be minimal: itself failing, every proper single-drop passing.
        const chainIds = res.conflict.constraintIds;
        const chainSet = failing.filter((c) => chainIds.includes(c.id));
        assert.equal(oracleUnify(chainSet).ok, false, `seed=${seed}: chain not failing`);
        for (const dropId of chainIds) {
          const rest = chainSet.filter((c) => c.id !== dropId);
          assert.equal(
            oracleUnify(rest).ok,
            true,
            `seed=${seed}: chain not minimal after dropping #${dropId}`,
          );
        }
        // Chain ids must be sorted ascending.
        const sorted = [...chainIds].sort((a, b) => a - b);
        assert.deepEqual(chainIds, sorted);
        break;
      }
    }

    if (failedAt === null) {
      accepted++;
      // Whole sequence accepted: oracle must accept too, and expansions must match.
      const oracle = oracleUnify(kept);
      assert.equal(oracle.ok, true, `seed=${seed}: oracle rejected an accepted set`);
      if (!oracle.ok) continue;
      // Small-term expansion: both sides of every constraint expand identically.
      assert.ok(
        expansionHolds(kept, oracle.subst),
        `seed=${seed}: expansion check failed`,
      );
      // Main unifier's resolution must agree with oracle expansion on every variable.
      for (let v = 0; v < SPEC.varCount; v++) {
        const fromMain = u.resolve(tvar(v));
        const fromOracle = oracleExpand(oracle.subst, tvar(v));
        assert.ok(
          typeEquals(fromMain, fromOracle),
          `seed=${seed}: t${v} differs: ${showType(fromMain)} vs ${showType(fromOracle)}`,
        );
      }
    } else {
      rejected++;
    }
  }
  assert.ok(accepted > 0 && rejected > 0, `want both outcomes, got ${accepted}/${rejected}`);
  console.log(`random cross-check: ${accepted} accepted, ${rejected} rejected over ${SEEDS} seeds`);
});

test("random undo sequences keep main unifier consistent with oracle", () => {
  for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
    const rand = mulberry32(seed);
    const raws = randomConstraints(rand, 6, SPEC);
    const u = new Unifier();
    const kept: Constraint[] = [];
    for (const raw of raws) {
      const res = u.add(raw.name, raw.left, raw.right);
      if (res.ok) kept.push({ id: res.id, name: raw.name, left: raw.left, right: raw.right });
    }
    // Undo a random subset of names.
    const names = [...new Set(raws.map((r) => r.name))];
    for (const name of names) {
      if (rand() < 0.5) u.undo(name);
    }
    const remaining = kept.filter((c) => u.listConstraints().some((k) => k.id === c.id));
    const oracle = oracleUnify(remaining);
    assert.equal(oracle.ok, true, `seed=${seed}: remaining set must unify`);
    if (!oracle.ok) continue;
    for (let v = 0; v < SPEC.varCount; v++) {
      const fromMain = u.resolve(tvar(v));
      const fromOracle = oracleExpand(oracle.subst, tvar(v));
      assert.ok(
        typeEquals(fromMain, fromOracle),
        `seed=${seed}: post-undo t${v} differs: ${showType(fromMain)} vs ${showType(fromOracle)}`,
      );
    }
  }
});

test("random snapshots stay frozen under later undo/add churn", () => {
  for (let seed = 2000; seed < 2100; seed++) {
    const rand = mulberry32(seed);
    const raws = randomConstraints(rand, 5, SPEC);
    const u = new Unifier();
    const kept: { name: string; left: (typeof raws)[0]["left"]; right: (typeof raws)[0]["right"] }[] = [];
    for (const raw of raws) {
      if (u.add(raw.name, raw.left, raw.right).ok) kept.push(raw);
    }
    const snap = u.snapshot();
    const captured = new Map(snap.bindings());
    // Churn: undo everything, then add fresh random constraints.
    for (const k of kept) u.undo(k.name);
    randomConstraints(rand, 4, SPEC).forEach((raw, i) => u.add(`x${i}`, raw.left, raw.right));
    const after = snap.bindings();
    assert.deepEqual(after, captured, `seed=${seed}: snapshot changed after churn`);
  }
});
