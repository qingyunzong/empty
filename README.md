# binpack-cli

Exact bin packing CLI (TypeScript, Node.js built-in modules only, zero runtime
dependencies).

Up to 20 items are packed into bins of a fixed integer capacity:

- items in the same **group** must share a bin;
- **forbidden pairs** must not share a bin;
- objective 1: minimize the number of bins;
- objective 2: among all min-bin solutions, minimize the load sequence of the
  bins taken in canonical order (each bin ordered by its smallest item id),
  compared lexicographically;
- output bin numbers are normalized the same way: the bin holding the
  smallest item id is bin 1, the bin holding the smallest remaining item id
  is bin 2, and so on.

## Usage

```sh
npm run build          # compiles src/ and test/ to dist/ (requires tsc)
node dist/src/cli.js instance.json
cat instance.json | node dist/src/cli.js
node dist/src/cli.js --help
```

### Input (JSON, file argument or stdin)

```json
{
  "capacity": 12,
  "items": [
    { "id": 1, "size": 4, "group": "a" },
    { "id": 2, "size": 3, "group": "a" },
    { "id": 3, "size": 5 },
    { "id": 4, "size": 6 }
  ],
  "forbidden": [[3, 4]]
}
```

`group` is optional (string or number); items without a group are on their
own. `forbidden` is an optional list of id pairs.

### Output

```json
{ "bins": 2, "loads": [12, 6], "assignment": { "1": 1, "2": 1, "3": 1, "4": 2 } }
```

`loads[i]` is the total size of bin `i + 1`; `assignment` maps every item id
to its 1-based bin number. Exit codes: `0` solved, `1` infeasible
(e.g. a forbidden pair inside one group, or a group larger than the
capacity), `2` invalid input.

## How it works

1. Same-group items are merged into indivisible units; forbidden pairs become
   a conflict bitmask between units.
2. Units are placed in ascending order of their smallest member item id, so
   bins are created in canonical order and the load sequence in creation
   order is exactly the canonical key.
3. The minimal bin count `k` is found by feasibility DFS (lower bound:
   `ceil(total / capacity)`), with a remaining-capacity bound and an
   interchangeable-bin symmetry break (equal load + conflict mask + cap).
4. The canonical load sequence is then determined one position at a time:
   positions before `b` are pinned to their optimum (equality checked at
   leaves) and position `b` is minimized by binary search over its load cap,
   each step a constrained feasibility DFS. The last position follows
   directly from the total.
5. One assignment attaining the optimal key is reconstructed and normalized
   so that bin numbers follow the smallest member item id.

## Tests

```sh
npm test    # tsc build + node --test
```

The suite includes a brute-force cross-check: `test/brute.ts` enumerates all
set partitions of the items (restricted growth strings), filters by the
group/forbidden/capacity constraints and computes the exact optimum of
(bin count, canonical load sequence). 400 seeded random small instances
(2-9 items, random groups and forbidden pairs, both feasible and infeasible
cases) are checked against the solver, and every returned assignment is
validated against all constraints and the bin-number normalization.

### Recorded results (2026-10-05, Node v22.22.1, tsc 7.0.2)

```
$ npm test
> npm run build && node --test dist/test/*.test.js
# tests 2
# pass 2
# fail 0
# duration_ms ~400-500

dist/test/solver.test.js: 12 tests, 12 pass (incl. 400-instance brute-force cross-check)
dist/test/cli.test.js:      7 tests,  7 pass
```

CLI smoke runs (actual output):

```
$ echo '{"capacity":10,"items":[{"id":1,"size":6},{"id":2,"size":4},{"id":3,"size":4},{"id":4,"size":2}],"forbidden":[[1,3]]}' | node dist/src/cli.js
{"bins":2,"loads":[6,10],"assignment":{"1":1,"2":2,"3":2,"4":2}}        # exit 0

$ echo '{"capacity":3,"items":[{"id":1,"size":2,"group":"g"},{"id":2,"size":2,"group":"g"}]}' | node dist/src/cli.js
{"error":"infeasible","message":"group with items [1, 2] has size 4 > capacity 3"}   # exit 1

$ echo '{"capacity":3,"items":[]}' | node dist/src/cli.js
{"error":"invalid_input","message":"items must be a non-empty array"}   # exit 2
```

## Layout

- `src/solver.ts` - exact solver (validation, grouping, search).
- `src/cli.ts` - CLI entry; `runCli(argv, stdin)` is a pure, testable core.
- `test/solver.test.ts` - unit tests + randomized brute-force cross-check.
- `test/brute.ts` - reference partition enumerator used by the tests.
- `test/cli.test.ts` - CLI behavior tests (exit codes, file/stdin, errors).
- `types/node.d.ts` - local ambient declarations for the Node built-ins used
  (the sandbox has no `@types/node`; only built-in modules are declared).
