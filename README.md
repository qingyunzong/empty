# patchtool — minimum-cost executable patches between file trees

`patchtool` explains the difference between two file trees as a
**minimum-cost, actually executable** patch, and ships an independently
verifiable optimality certificate.  Pure Python 3.11 standard library;
tests use `unittest`.

## Cost model (all costs are non-negative integers)

| operation | cost |
|---|---|
| `add` / `delete` | byte size of the file content (`len(line)+1` per line, UTF-8) |
| `modify`       | shortest line edit script length (insertions + deletions = `n+m-2·lcs`) |
| `rename`       | path edit distance (char Levenshtein) **+** content edit script length |

A path **swap** is a rename 2-cycle and is handled like any rename cycle.

## How it works

1. **Matching, not greedy hashing.**  Pairing source and destination files
   is a global assignment problem: candidate rename cost = path edit
   distance + content edit distance; deleting/adding costs the byte size.
   The `n+m` square reduction (real rows/cols plus add/delete dummies) is
   solved with a Hungarian algorithm (`patchtool/matching.py`), so files
   with identical hashes are *never* pre-paired greedily — the tests
   include cases where the optimum pairs contents across different paths.
2. **Tie-breaking.**  Among all optimal matchings, the one whose
   normalised operation sequence (sorted tuples `("add",p)`,
   `("delete",p)`, `("modify",p)`, `("rename",s,d)`) is lexicographically
   smallest is chosen, via greedy prefix extension with constrained
   re-optimisation.
3. **Executable plan.**  Operations are ordered into primitive steps
   (`delete`, `rename`, `mkdir`, `rmdir`, `add`, `modify`).  Rename cycles
   (including swaps) and rename/mkdir deadlocks (file ↔ directory changes,
   path-prefix conflicts) are broken by parking the *blocking* file under
   a temporary name `.patch-tmp-N` that collides with no input path.
4. **Atomic apply.**  `apply_patch` validates **all** source fingerprints
   (SHA-256 of canonical content) before touching anything and works on a
   copy — on any failure the target tree is completely unchanged.  After
   executing the plan it verifies the destination fingerprints.
5. **Certificate.**  The patch carries the assignment and the Hungarian
   dual potentials `u`, `v`.  The verifier
   (`patchtool/certificate.py`) recomputes the cost matrix and checks:
   permutation, matched cost = claimed cost, dual feasibility
   `u[i]+v[j] ≤ c[i][j]`, complementary slackness on matched cells, and
   `Σu + Σv = cost`.  By weak duality this proves optimality — **the
   verifier runs no optimiser**.

## CLI

```sh
python3.11 -m patchtool diff   OLD.json NEW.json [-o patch.json]
python3.11 -m patchtool apply  TREE.json PATCH.json [-o out.json]
python3.11 -m patchtool verify OLD.json NEW.json PATCH.json
```

Tree JSON: `{"entries": [{"path": "a", "type": "dir"},
{"path": "a/f", "type": "file", "lines": ["..."]}]}`.
Patch JSON: `{version, cost, ops, plan, src_fingerprints,
dst_fingerprints, certificate}`.

## Library

```python
from patchtool import FileTree, diff_trees, apply_patch, verify_certificate
patch = diff_trees(old_tree, new_tree)          # dict, JSON-serialisable
new_tree2 = apply_patch(old_tree, patch)        # atomic, pure
verify_certificate(old_tree, new_tree, patch["certificate"],
                   expected_ops=[("rename", "a", "b")])
```

`patchtool/enumerate.py` provides `brute_force_best`, an independent
enumerator of all legal matchings used by the test-suite to cross-check
optimality and the tie-break rule for up to 7 files.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Last recorded run: `Ran 40 tests ... OK` (Python 3.11.16).

Covers: full enumeration cross-check (≤ 7 files, cost **and** lexicographic
tie-break), three-path rename cycles, path swaps, cross-path pairing
beating same-name modify, duplicate contents, path-prefix conflicts
(file↔dir, rename into new subdirectories, rename/mkdir deadlock),
certificate tampering (cost, potentials, assignment, labels, hashes),
atomic apply on fingerprint mismatch, and apply-then-reverse restore.
