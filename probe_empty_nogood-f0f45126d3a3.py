"""Check whether a persisted empty nogood rejects the empty assignment."""

import os
import sys
import tempfile
from pathlib import Path


sys.path.insert(0, os.getcwd())

from csp_persist.log import append_clause, load_clauses  # noqa: E402
from csp_persist.solver import CSPSolver, NogoodStore  # noqa: E402


with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "nogoods.log"
    append_clause(str(path), [])
    clauses = load_clauses(str(path))
    store = NogoodStore()
    for clause in clauses:
        store.add(clause)
    solver = CSPSolver({}, store)
    result = solver.solve()

print(f"loaded={clauses!r}")
print(f"empty_assignment_conflicts={store.is_violated({})!r}")
print(f"solve_result={result!r}; pruned={solver.pruned}")

assert clauses == [[]], "empty nogood did not survive log round trip"
assert store.is_violated({}), "empty nogood was not added to the clause database"
assert result == {} and solver.pruned == 0, "reported defect did not reproduce"
