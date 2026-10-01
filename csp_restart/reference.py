"""Naive backtracking reference solver (no propagation, no nogoods)."""


def naive_solve(problem):
    """Return the first solution in variable/domain order, or None."""
    assignment = {}

    def backtrack():
        var = next((v for v in problem.variables if v not in assignment), None)
        if var is None:
            return dict(assignment)
        for value in problem.domains[var]:
            assignment[var] = value
            if all(c.is_consistent(assignment) for c in problem.constraints):
                result = backtrack()
                if result is not None:
                    return result
            del assignment[var]
        return None

    return backtrack()
