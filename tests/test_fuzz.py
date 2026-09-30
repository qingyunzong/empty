"""Acceptance E: random tables (<=20 rows) and policies (<=50 rules)
must agree with the independent per-cell reference evaluator."""
import random
import unittest

from maskview import MaskView, PolicyError
from tests.reference import RefError, reference_query

INT_COLS = ["id", "age", "score"]
STR_COLS = ["name", "dept", "city"]
BOOL_COLS = ["active"]
ALL_COLS = INT_COLS + STR_COLS + BOOL_COLS
DEPTS = ["eng", "ops", "hr"]
NAMES = ["ada", "bob", "cy", "di"]
CITIES = ["sh", "bj", "gz"]


def gen_value(rng, column):
    if rng.random() < 0.15:
        return None
    if column == "id":
        return rng.randint(1, 100)
    if column == "age":
        return rng.randint(18, 70)
    if column == "score":
        return rng.randint(0, 100)
    if column == "name":
        return rng.choice(NAMES)
    if column == "dept":
        return rng.choice(DEPTS)
    if column == "city":
        return rng.choice(CITIES)
    return rng.random() < 0.5


def gen_atom(rng, columns):
    column = rng.choice(columns)
    if column in INT_COLS:
        op = rng.choice(["==", "!=", "<", "<=", ">", ">="])
        return f"{column} {op} {rng.randint(0, 100)}"
    if column in STR_COLS:
        pool = DEPTS if column == "dept" else (NAMES if column == "name" else CITIES)
        if rng.random() < 0.3:
            picks = rng.sample(pool, k=rng.randint(1, len(pool)))
            listed = ", ".join(repr(p) for p in picks)
            return f"{column} in [{listed}]"
        return f"{column} == {rng.choice(pool)!r}"
    return f"{column} == {rng.choice(['True', 'False'])}"


def gen_expr(rng, columns, depth=0):
    roll = rng.random()
    if depth >= 2 or roll < 0.45:
        atom = gen_atom(rng, columns)
        if rng.random() < 0.15:
            col = rng.choice(columns)
            atom = rng.choice([f"{col} is null", f"{col} is not null", atom])
        return atom
    if roll < 0.6:
        return f"not ({gen_expr(rng, columns, depth + 1)})"
    joiner = rng.choice(["and", "or"])
    return f"({gen_expr(rng, columns, depth + 1)}) {joiner} ({gen_expr(rng, columns, depth + 1)})"


def gen_case(rng):
    columns = rng.sample(ALL_COLS, k=rng.randint(3, 6))
    if "id" not in columns:
        columns[0] = "id"
    rows = [
        {col: gen_value(rng, col) for col in columns}
        for _ in range(rng.randint(0, 20))
    ]
    data = {"columns": columns, "rows": rows}

    sensitivity = {
        col: rng.choice(["low", "medium", "high"])
        for col in columns
        if rng.random() < 0.5
    }
    budget = rng.randint(1, 50)
    n_filters = rng.randint(0, min(5, budget))
    filters = [
        {"when": gen_expr(rng, columns), "effect": rng.choice(["allow", "deny"])}
        for _ in range(n_filters)
    ]
    rules = []
    for _ in range(budget - n_filters):
        rule = {"action": rng.choice(["clear", "hash", "redact", "drop"])}
        if rng.random() < 0.7:
            rule["column"] = rng.choice(columns)
        else:
            rule["sensitivity_at_least"] = rng.choice(["low", "medium", "high"])
        if rng.random() < 0.4:
            rule["when"] = gen_expr(rng, columns)
        rules.append(rule)
    policy = {
        "sensitivity": sensitivity,
        "roles": {"analyst": {"row_filters": filters, "column_rules": rules}},
    }
    sort_by = rng.choice([None] + columns)
    descending = rng.random() < 0.3
    return data, policy, sort_by, descending


class FuzzTests(unittest.TestCase):
    def test_matches_reference_evaluator(self):
        rng = random.Random(20260930)
        checked = 0
        errors_matched = 0
        for iteration in range(600):
            data, policy, sort_by, descending = gen_case(rng)
            try:
                expected = reference_query(
                    data, policy, "analyst", sort_by=sort_by, descending=descending
                )
            except RefError as ref_exc:
                with self.assertRaises(PolicyError, msg=f"iteration {iteration}") as ctx:
                    MaskView(data, policy).query(
                        "analyst", sort_by=sort_by, descending=descending
                    )
                self.assertEqual(
                    ctx.exception.code, ref_exc.code,
                    msg=f"iteration {iteration}: sort_by={sort_by} desc={descending}",
                )
                errors_matched += 1
                continue
            actual = MaskView(data, policy).query(
                "analyst", sort_by=sort_by, descending=descending
            )
            self.assertEqual(
                expected, actual,
                msg=f"iteration {iteration}: sort_by={sort_by} desc={descending}",
            )
            checked += 1
        self.assertGreater(checked, 250)
        self.assertGreater(errors_matched, 50)


if __name__ == "__main__":
    unittest.main()
