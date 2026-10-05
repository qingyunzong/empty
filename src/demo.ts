import { CommitDag } from "./dag.js";

/** Small demo: build a multi-parent DAG, print NCAs and certificates. */
const dag = new CommitDag();
dag.addCommit("A");
dag.addCommit("B", ["A"]);
dag.addCommit("C", ["A"]);
dag.addCommit("D", ["B"]);
dag.addCommit("E", ["B", "C"]); // merge
dag.addCommit("F", ["C"]);
dag.addCommit("J", ["B", "C"]); // criss-cross partner of K
dag.addCommit("K", ["B", "C"]);
dag.addCommit("G", ["E", "F"]); // merge
dag.addCommit("H", ["D", "E"]); // merge
dag.addCommit("I", ["G", "H"]); // merge

for (const bases of [["D", "F"], ["E", "F"], ["H", "G"], ["J", "K"], ["H", "G", "K"]]) {
  console.log(`NCA(${bases.join(", ")}) = [${dag.lowestCommonAncestors(bases).join(", ")}]`);
}

console.log("\nAncestor certificate (A ancestor of I):");
console.log(JSON.stringify(dag.ancestorCertificate("A", "I"), null, 2));

console.log("\nLCA certificate for bases [J, K]:");
console.log(JSON.stringify(dag.lcaCertificate(["J", "K"]), null, 2));

try {
  dag.addCommit("Z", ["Z"]);
} catch (e) {
  console.log(`\nCycle rejection demo: ${(e as Error).name}: ${(e as Error).message}`);
}
