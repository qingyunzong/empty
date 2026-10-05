import { test } from "node:test";
import assert from "node:assert/strict";
import { CommitDag, CycleError, DagError } from "../src/dag.js";
import { modelIsAncestor, modelLcas, reachabilitySets } from "../src/model.js";

/**
 * Small multi-parent DAG used by all tests:
 *
 *     A
 *    / \
 *   B   C
 *  /|\ /|\
 * D E X J K        (E, J, K all merge B and C)
 *  \|/ \|
 *   H   F
 *    \ / \
 *     \   G        (G merges E and F)
 *      \ /
 *       I          (I merges G and H)
 */
function buildDag(): CommitDag {
  const dag = new CommitDag();
  dag.addCommit("A");
  dag.addCommit("B", ["A"]);
  dag.addCommit("C", ["A"]);
  dag.addCommit("D", ["B"]);
  dag.addCommit("E", ["B", "C"]);
  dag.addCommit("F", ["C"]);
  dag.addCommit("J", ["B", "C"]);
  dag.addCommit("K", ["B", "C"]);
  dag.addCommit("G", ["E", "F"]);
  dag.addCommit("H", ["D", "E"]);
  dag.addCommit("I", ["G", "H"]);
  return dag;
}

const TABLE = buildDag().snapshot();
const NODES = Object.keys(TABLE);

test("insertion: rejects duplicates, dangling parents, repeated parents, empty id", () => {
  const dag = buildDag();
  assert.throws(() => dag.addCommit("A"), DagError);
  assert.throws(() => dag.addCommit("Z", ["NOPE"]), DagError);
  assert.throws(() => dag.addCommit("Z", ["A", "A"]), DagError);
  assert.throws(() => dag.addCommit(""), DagError);
  assert.equal(dag.size, NODES.length);
});

test("insertion: rejects cycles (self-loop and reachability check)", () => {
  const dag = buildDag();
  assert.throws(() => dag.addCommit("Z", ["Z"]), CycleError);
  // Adding edges id -> parents closes a cycle iff id is an ancestor of a parent.
  assert.equal(dag.createsCycle("A", ["I"]), true); // A is ancestor of I
  assert.equal(dag.createsCycle("E", ["G"]), true); // E is ancestor of G
  assert.equal(dag.createsCycle("B", ["J"]), true); // B is ancestor of J
  assert.equal(dag.createsCycle("I", ["A"]), false); // I is not an ancestor of A
  assert.equal(dag.createsCycle("G", ["E"]), false);
  assert.equal(dag.createsCycle("FRESH", ["A", "I"]), false); // new node: acyclic
});

test("nearest common ancestors: hand-computed expectations", () => {
  const dag = buildDag();
  const lca = (bases: string[]) => dag.lowestCommonAncestors(bases).sort();
  assert.deepEqual(lca(["D", "F"]), ["A"]); // only the root is common
  assert.deepEqual(lca(["E", "F"]), ["C"]); // C is closer than A
  assert.deepEqual(lca(["H", "G"]), ["E"]); // E dominates B, C, A
  assert.deepEqual(lca(["J", "K"]), ["B", "C"]); // two incomparable NCAs
  assert.deepEqual(lca(["I", "K"]), ["B", "C"]);
  assert.deepEqual(lca(["B", "D"]), ["B"]); // a base can be its own NCA
  assert.deepEqual(lca(["A", "I"]), ["A"]);
  assert.deepEqual(lca(["D", "F", "I"]), ["A"]); // triple base
  assert.deepEqual(lca(["H", "G", "K"]), ["B", "C"]); // triple, two NCAs
  assert.deepEqual(lca(["I"]), ["I"]); // single base
});

test("model cross-check: NCA matches full-reachability model for all pairs and triples", () => {
  const dag = buildDag();
  const sorted = (xs: string[]) => [...xs].sort();
  let checked = 0;
  for (const a of NODES) {
    for (const b of NODES) {
      assert.deepEqual(sorted(dag.lowestCommonAncestors([a, b])), sorted(modelLcas(TABLE, [a, b])));
      checked++;
      for (const c of NODES) {
        assert.deepEqual(
          sorted(dag.lowestCommonAncestors([a, b, c])),
          sorted(modelLcas(TABLE, [a, b, c])),
        );
        checked++;
      }
    }
  }
  assert.equal(checked, NODES.length ** 2 + NODES.length ** 3);
});

test("model cross-check: ancestor relation matches for all ordered pairs", () => {
  const dag = buildDag();
  for (const a of NODES) {
    for (const b of NODES) {
      assert.equal(dag.isAncestor(a, b), modelIsAncestor(TABLE, a, b));
    }
  }
});

test("model cross-check: reachability sets match dag.ancestors()", () => {
  const dag = buildDag();
  const reach = reachabilitySets(TABLE);
  for (const id of NODES) {
    assert.deepEqual([...dag.ancestors(id)].sort(), [...reach.get(id)!].sort());
  }
});

test("ancestor certificates: issued and verified for every true relation", () => {
  const dag = buildDag();
  let issued = 0;
  for (const a of NODES) {
    for (const b of NODES) {
      if (modelIsAncestor(TABLE, a, b)) {
        const cert = dag.ancestorCertificate(a, b);
        assert.equal(cert.path[0], b);
        assert.equal(cert.path[cert.path.length - 1], a);
        assert.ok(dag.verifyAncestorCertificate(cert));
        issued++;
      } else {
        assert.throws(() => dag.ancestorCertificate(a, b), DagError);
      }
    }
  }
  assert.ok(issued > NODES.length); // more than just the reflexive ones
});

test("ancestor certificates: tampered certificates are rejected", () => {
  const dag = buildDag();
  const cert = dag.ancestorCertificate("B", "I");
  assert.ok(dag.verifyAncestorCertificate(cert));
  // Wrong claimed ancestor.
  assert.ok(!dag.verifyAncestorCertificate({ ...cert, ancestor: "C" }));
  // Wrong claimed descendant.
  assert.ok(!dag.verifyAncestorCertificate({ ...cert, descendant: "G" }));
  // Broken edge inside the path.
  const broken = { ...cert, path: [...cert.path] };
  broken.path[1] = "F";
  assert.ok(!dag.verifyAncestorCertificate(broken));
  // Unknown node.
  assert.ok(!dag.verifyAncestorCertificate({ ...cert, path: ["I", "GHOST", "B"] }));
  // Empty path.
  assert.ok(!dag.verifyAncestorCertificate({ ...cert, path: [] }));
});

test("LCA certificates: verified, and tampering is detected", () => {
  const dag = buildDag();
  for (const bases of [["J", "K"], ["H", "G", "K"], ["D", "F"], ["I"]]) {
    const cert = dag.lcaCertificate(bases);
    assert.ok(dag.verifyLcaCertificate(cert));
    // Dropping a real LCA breaks the certificate.
    if (cert.lcas.length > 1) {
      const dropped = { ...cert, lcas: cert.lcas.slice(1) };
      assert.ok(!dag.verifyLcaCertificate(dropped));
    }
    // Claiming an extra LCA breaks the certificate.
    const extra = { ...cert, lcas: [...cert.lcas, "A"] };
    assert.ok(!dag.verifyLcaCertificate(extra));
    // Corrupting a witness path breaks the certificate.
    const lca0 = cert.lcas[0];
    const base0 = cert.bases[0];
    const corrupted = structuredClone(cert);
    corrupted.paths[lca0][base0] = [base0, lca0]; // skips intermediate commits
    assert.equal(dag.verifyLcaCertificate(corrupted), pathIsDirectEdge(dag, base0, lca0));
  }
});

function pathIsDirectEdge(dag: CommitDag, from: string, to: string): boolean {
  return from !== to && dag.parents(from).includes(to);
}

test("certificate output sample (recorded in test log)", (t) => {
  const dag = buildDag();
  const anc = dag.ancestorCertificate("A", "I");
  const lca = dag.lcaCertificate(["J", "K"]);
  t.diagnostic(`ancestor certificate: ${JSON.stringify(anc)}`);
  t.diagnostic(`lca certificate: ${JSON.stringify(lca)}`);
  assert.ok(dag.verifyAncestorCertificate(anc));
  assert.ok(dag.verifyLcaCertificate(lca));
});
