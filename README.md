# joinview

Maintains a materialized view over bag-semantics relations R(A, K) and
S(K, B): per A, the join-row count and the sum of B over R join S.
Pure Python 3.11 standard library.

## Usage

    python -m joinview state.json script.json

Prints the view (of the committed state) as JSON to stdout, e.g.
[{"A": "g1", "count": 2, "sum": 7}].

Exit codes: 0 success, 1 usage/IO/JSON errors, 2 script semantic
error (committed state left untouched).

## Formats

state.json (missing file means empty state):

    {"R": [{"A": 1, "K": "k"}], "S": [{"K": "k", "B": 5}]}

script.json is a list of commands:

    {"op": "begin"}
    {"op": "commit"} | {"op": "rollback"}
    {"op": "savepoint"|"release"|"rollback", "name": "sp1"}
    {"op": "insert"|"delete", "rel": "R", "A": ..., "K": ...}
    {"op": "insert"|"delete", "rel": "S", "K": ..., "B": ...}

## Semantics

- Bag semantics: duplicate rows carry multiplicity; delete removes one
  occurrence. null keys never join; null B counts toward the row count
  but does not contribute to the sum.
- Savepoints form a nested stack. "rollback name" undoes changes after
  the savepoint but keeps it (and drops later savepoints).
  "release name" removes it and all later savepoints, so a subsequent
  rollback to that name is an error.
- Semantic errors (exit 2): delete exceeding multiplicity, duplicate
  active savepoint name, commit/rollback/DML without an active
  transaction, rollback/release of an unknown savepoint, nested begin,
  unknown op. A semantic error aborts the transaction; committed state
  is unchanged.
- Only commit persists to state.json; an uncommitted script changes
  nothing on disk.

## Tests

    python3 -m unittest discover -s tests -v

The suite recomputes the view with an independent nested-loop
implementation and compares it against the CLI output.
