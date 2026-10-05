import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MerkleTree,
  emptyTreeRoot,
  hashLeaf,
  generateConsistencyProof,
  verifyConsistencyProof,
  generateInclusionProof,
  verifyInclusionProof,
} from "../src/index";

const MAX_LEAVES = 16;

function buildTree(n: number): MerkleTree {
  const tree = new MerkleTree();
  for (let i = 0; i < n; i++) tree.append(`leaf-${i}`);
  return tree;
}

const tree = buildTree(MAX_LEAVES);

function flipOneBit(node: Buffer): Buffer {
  const copy = Buffer.from(node);
  copy[0] = (copy[0]! ^ 0x01) & 0xff;
  return copy;
}

describe("hash primitives", () => {
  it("empty tree root is SHA-256 of the empty string", () => {
    assert.equal(
      emptyTreeRoot().toString("hex"),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("leaf hash is SHA-256 of 0x00 || data", () => {
    assert.equal(
      hashLeaf(Buffer.from("")).toString("hex"),
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
  });
});

describe("empty-tree and equal-tree rules", () => {
  it("proof generation: empty first tree or equal sizes yield an empty proof", () => {
    for (let n = 0; n <= MAX_LEAVES; n++) {
      assert.deepEqual(generateConsistencyProof(tree, 0, n), []);
      assert.deepEqual(generateConsistencyProof(tree, n, n), []);
    }
  });

  it("proof generation: first > second is rejected", () => {
    assert.throws(() => generateConsistencyProof(tree, 2, 1));
    assert.throws(() => generateConsistencyProof(tree, 1, MAX_LEAVES + 1));
  });

  it("empty tree is a prefix of every tree (empty proof, well-known empty root)", () => {
    for (let n = 0; n <= MAX_LEAVES; n++) {
      const secondRoot = tree.root(n);
      assert.ok(verifyConsistencyProof(0, n, emptyTreeRoot(), secondRoot, []), `0 -> ${n}`);
    }
  });

  it("empty-tree rule is strict: wrong empty root or non-empty proof fails", () => {
    const bogusRoot = tree.root(1);
    assert.ok(!verifyConsistencyProof(0, 3, bogusRoot, tree.root(3), []));
    assert.ok(!verifyConsistencyProof(0, 3, emptyTreeRoot(), tree.root(3), [tree.root(1)]));
    assert.ok(!verifyConsistencyProof(0, 0, emptyTreeRoot(), bogusRoot, []));
  });

  it("equal sizes need an empty proof and identical roots", () => {
    for (let n = 1; n <= MAX_LEAVES; n++) {
      assert.ok(verifyConsistencyProof(n, n, tree.root(n), tree.root(n), []), `n=${n}`);
      assert.ok(!verifyConsistencyProof(n, n, tree.root(n), tree.root(n), [tree.root(1)]));
      if (n > 1) assert.ok(!verifyConsistencyProof(n, n, tree.root(n), tree.root(n - 1), []));
    }
  });

  it("rejects malformed sizes and proof nodes", () => {
    const r1 = tree.root(1);
    const r2 = tree.root(2);
    const proof = generateConsistencyProof(tree, 1, 2);
    assert.ok(!verifyConsistencyProof(2, 1, r2, r1, []));
    assert.ok(!verifyConsistencyProof(-1, 2, r1, r2, []));
    assert.ok(!verifyConsistencyProof(1.5, 2, r1, r2, proof));
    assert.ok(!verifyConsistencyProof(1, 2, r1, r2, [Buffer.alloc(31)]));
    assert.ok(!verifyConsistencyProof(1, 2, r1, r2, [Buffer.alloc(33)]));
  });
});

describe("exhaustive valid consistency proofs (all size pairs up to 16 leaves)", () => {
  it("every honestly generated proof verifies", () => {
    let checked = 0;
    for (let second = 0; second <= MAX_LEAVES; second++) {
      for (let first = 0; first <= second; first++) {
        const proof = generateConsistencyProof(tree, first, second);
        assert.ok(
          verifyConsistencyProof(first, second, tree.root(first), tree.root(second), proof),
          `valid proof ${first} -> ${second} rejected`,
        );
        if (first === 0 || first === second) {
          assert.equal(proof.length, 0, `proof ${first} -> ${second} must be empty`);
        } else {
          assert.ok(proof.length >= 1 && proof.length <= Math.ceil(Math.log2(second)) + 1);
        }
        checked++;
      }
    }
    assert.equal(checked, ((MAX_LEAVES + 1) * (MAX_LEAVES + 2)) / 2);
  });
});

describe("proof-node corruption is always rejected", () => {
  it("bit flips, truncation, extension, reordering, and wrong roots all fail", () => {
    let corrupted = 0;
    for (let second = 1; second <= MAX_LEAVES; second++) {
      for (let first = 1; first < second; first++) {
        const firstRoot = tree.root(first);
        const secondRoot = tree.root(second);
        const proof = generateConsistencyProof(tree, first, second);
        const label = `${first} -> ${second}`;
        const reject = (p: Buffer[], fr = firstRoot, sr = secondRoot) => {
          assert.ok(!verifyConsistencyProof(first, second, fr, sr, p), `${label}: corruption accepted`);
          corrupted++;
        };

        for (let i = 0; i < proof.length; i++) {
          const bitFlipped = [...proof];
          bitFlipped[i] = flipOneBit(proof[i]!);
          reject(bitFlipped);

          const zeroed = [...proof];
          zeroed[i] = Buffer.alloc(32);
          reject(zeroed);

          reject(proof.filter((_, j) => j !== i)); // node removed
        }
        reject([...proof, tree.root(0)]); // extra node appended
        reject([tree.root(0), ...proof]); // extra node prepended
        reject([]); // empty proof for unequal non-empty trees
        if (proof.length >= 2) {
          const swapped = [...proof];
          [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
          reject(swapped);
        }
        reject(proof, secondRoot, firstRoot); // roots swapped
        reject(proof, tree.root(second), tree.root(second)); // wrong first root
        reject(proof, tree.root(first), tree.root(first)); // wrong second root
      }
    }
    assert.ok(corrupted > 0);
  });
});

describe("an inclusion proof cannot masquerade as a consistency proof", () => {
  it("inclusion proofs verify as inclusion proofs (sanity)", () => {
    for (let size = 1; size <= MAX_LEAVES; size++) {
      for (let index = 0; index < size; index++) {
        const proof = generateInclusionProof(tree, index, size);
        assert.ok(
          verifyInclusionProof(Buffer.from(`leaf-${index}`), index, size, tree.root(size), proof),
          `inclusion ${index}/${size}`,
        );
      }
    }
  });

  it("consistency verifier rejects inclusion proofs for every size pair", () => {
    let rejected = 0;
    for (let second = 2; second <= MAX_LEAVES; second++) {
      for (let first = 1; first < second; first++) {
        for (let index = 0; index < second; index++) {
          const inclusion = generateInclusionProof(tree, index, second);
          const accepted = verifyConsistencyProof(first, second, tree.root(first), tree.root(second), inclusion);
          // Sole legitimate overlap: the audit path of leaf 0 IS the
          // consistency proof for (1, n). Everything else must be rejected.
          if (first === 1 && index === 0) {
            assert.ok(accepted, `leaf-0 audit path is the valid (1, ${second}) consistency proof`);
          } else {
            assert.ok(!accepted, `inclusion proof of leaf ${index}/${second} accepted as consistency ${first} -> ${second}`);
            rejected++;
          }
        }
      }
    }
    assert.ok(rejected > 0);
  });

  it("a consistency proof does not verify as an inclusion proof either", () => {
    for (let second = 2; second <= MAX_LEAVES; second++) {
      const proof = generateConsistencyProof(tree, 1, second);
      const leafZeroPasses = verifyInclusionProof(Buffer.from("leaf-0"), 0, second, tree.root(second), proof);
      assert.ok(leafZeroPasses, "degenerate (1, n) consistency proof doubles as leaf-0 audit path");
      for (let index = 1; index < second; index++) {
        assert.ok(
          !verifyInclusionProof(Buffer.from(`leaf-${index}`), index, second, tree.root(second), proof),
          `consistency proof 1 -> ${second} accepted as inclusion of leaf ${index}`,
        );
      }
    }
  });
});
