import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AppendOnlyLog,
  EMPTY_ROOT,
  rootHash,
  verifyConsistency,
  verifyInclusion,
} from "../src/merkle.js";

const MAX_N = 16;
const leaves = Array.from({ length: MAX_N }, (_, i) => Buffer.from(`leaf-${i}`));

function logOf(n: number): AppendOnlyLog {
  const log = new AppendOnlyLog();
  for (let i = 0; i < n; i++) log.append(leaves[i]);
  return log;
}

function rootOf(n: number): Buffer {
  return n === 0 ? Buffer.from(EMPTY_ROOT) : rootHash(leaves.slice(0, n));
}

test("empty-tree and equal-size rules are explicit", () => {
  // m = n = 0: valid only with empty proof and equal (empty) roots.
  assert.equal(verifyConsistency(0, EMPTY_ROOT, 0, EMPTY_ROOT, []), true);
  assert.equal(verifyConsistency(0, EMPTY_ROOT, 0, randomBytes(32), []), false);
  assert.equal(verifyConsistency(0, EMPTY_ROOT, 0, EMPTY_ROOT, [randomBytes(32)]), false);

  for (let n = 1; n <= MAX_N; n++) {
    // m = 0 < n: the empty tree is a prefix of every tree; proof must be empty.
    assert.equal(verifyConsistency(0, EMPTY_ROOT, n, rootOf(n), []), true);
    assert.equal(verifyConsistency(0, EMPTY_ROOT, n, rootOf(n), [randomBytes(32)]), false);

    // m = n > 0: valid only with empty proof and identical roots.
    assert.equal(verifyConsistency(n, rootOf(n), n, rootOf(n), []), true);
    assert.equal(verifyConsistency(n, rootOf(n), n, rootOf(n), [randomBytes(32)]), false);
    assert.equal(verifyConsistency(n, rootOf(n), n, randomBytes(32), []), false);
  }

  // m > n is never consistent.
  assert.equal(verifyConsistency(3, rootOf(3), 2, rootOf(2), []), false);
  assert.equal(verifyConsistency(1, rootOf(1), 0, EMPTY_ROOT, []), false);
});

test("all pairs 0 <= m <= n <= 16 verify with the generated proof", () => {
  let checked = 0;
  for (let n = 0; n <= MAX_N; n++) {
    const log = logOf(n);
    for (let m = 0; m <= n; m++) {
      const proof = log.consistencyProof(m);
      assert.ok(
        verifyConsistency(m, rootOf(m), n, rootOf(n), proof),
        `m=${m} n=${n} proof=${proof.length} nodes`,
      );
      checked++;
    }
  }
  assert.equal(checked, ((MAX_N + 1) * (MAX_N + 2)) / 2);
});

test("every corrupted proof node is rejected", () => {
  let cases = 0;
  for (let n = 2; n <= MAX_N; n++) {
    const log = logOf(n);
    for (let m = 1; m < n; m++) {
      const proof = log.consistencyProof(m);
      assert.ok(proof.length > 0);

      // Flip the first and the last bit of every single proof node.
      for (let i = 0; i < proof.length; i++) {
        for (const [byte, bit] of [[0, 0], [31, 7]] as const) {
          const bad = proof.map((p, j) => {
            const c = Buffer.from(p);
            if (j === i) c[byte] ^= 1 << bit;
            return c;
          });
          assert.equal(
            verifyConsistency(m, rootOf(m), n, rootOf(n), bad),
            false,
            `m=${m} n=${n} corrupted node=${i} byte=${byte} bit=${bit}`,
          );
          cases++;
        }
      }

      // Remove each node in turn (truncation).
      for (let i = 0; i < proof.length; i++) {
        const bad = proof.filter((_, j) => j !== i);
        assert.equal(verifyConsistency(m, rootOf(m), n, rootOf(n), bad), false);
        cases++;
      }

      // Append an extra node (extension).
      assert.equal(
        verifyConsistency(m, rootOf(m), n, rootOf(n), [...proof, randomBytes(32)]),
        false,
      );
      cases++;

      // Swap the first two nodes.
      if (proof.length >= 2) {
        const bad = [...proof];
        [bad[0], bad[1]] = [bad[1], bad[0]];
        assert.equal(verifyConsistency(m, rootOf(m), n, rootOf(n), bad), false);
        cases++;
      }

      // Wrong roots.
      assert.equal(verifyConsistency(m, randomBytes(32), n, rootOf(n), proof), false);
      assert.equal(verifyConsistency(m, rootOf(m), n, randomBytes(32), proof), false);
      cases += 2;
    }
  }
  assert.ok(cases > 0);
});

test("a proof verifies only against its own genuine (size, root) pair", () => {
  for (let n = 2; n <= MAX_N; n++) {
    const log = logOf(n);
    for (let m = 1; m < n; m++) {
      const proof = log.consistencyProof(m);
      for (let n2 = 0; n2 <= MAX_N; n2++) {
        for (let m2 = 0; m2 <= n2; m2++) {
          const accepted = verifyConsistency(m2, rootOf(m2), n2, rootOf(n2), proof);
          assert.equal(
            accepted,
            m2 === m && n2 === n,
            `proof(${m},${n}) checked against (${m2},${n2})`,
          );
        }
      }
    }
  }
});

test("malformed inputs are rejected", () => {
  const proof = logOf(8).consistencyProof(3);
  // Proof node with wrong length.
  assert.equal(
    verifyConsistency(3, rootOf(3), 8, rootOf(8), proof.map((p) => p.subarray(0, 31))),
    false,
  );
  // Root with wrong length.
  assert.equal(verifyConsistency(3, randomBytes(16), 8, rootOf(8), proof), false);
  assert.equal(verifyConsistency(3, rootOf(3), 8, randomBytes(64), proof), false);
  // Negative / non-integer sizes.
  assert.equal(verifyConsistency(-1, EMPTY_ROOT, 8, rootOf(8), []), false);
  assert.equal(verifyConsistency(2.5, rootOf(2), 8, rootOf(8), proof), false);
  assert.equal(verifyConsistency(3, rootOf(3), Number.NaN, rootOf(8), proof), false);
});

test("an inclusion proof cannot masquerade as a consistency proof", () => {
  let rejected = 0;
  for (let n = 1; n <= MAX_N; n++) {
    const log = logOf(n);
    for (let leaf = 0; leaf < n; leaf++) {
      const inc = log.inclusionProof(leaf);
      // Sanity: it really is a valid inclusion proof.
      assert.ok(verifyInclusion(leaf, n, leaves[leaf], rootOf(n), inc));

      for (let m = 1; m < n; m++) {
        const genuine = log.consistencyProof(m);
        const isGenuine =
          inc.length === genuine.length && inc.every((p, i) => p.equals(genuine[i]));
        const accepted = verifyConsistency(m, rootOf(m), n, rootOf(n), inc);
        // The verifier must accept the inclusion proof ONLY in the degenerate
        // cases where it is byte-for-byte the genuine consistency proof.
        assert.equal(accepted, isGenuine, `leaf=${leaf} m=${m} n=${n}`);
        if (!accepted) rejected++;
      }
    }
  }
  assert.ok(rejected > 0, "expected inclusion proofs to be rejected");
});

test("inclusion proofs verify and reject tampering", () => {
  for (let n = 1; n <= MAX_N; n++) {
    const log = logOf(n);
    for (let i = 0; i < n; i++) {
      const proof = log.inclusionProof(i);
      assert.ok(verifyInclusion(i, n, leaves[i], rootOf(n), proof));
      assert.equal(verifyInclusion(i, n, Buffer.from("forged"), rootOf(n), proof), false);
      assert.equal(verifyInclusion(i, n, leaves[i], randomBytes(32), proof), false);
    }
  }
});
