"""Acceptance D: random small projects; after every patch the incremental
state must equal a full recheck, and unaffected modules keep diagnostics."""
import contextlib
import io
import json
import os
import random
import tempfile
import unittest

from mtc import core


def gen_module(rng, idx, exports_of):
    lines = []
    available = []
    for j in range(idx):
        if rng.random() < 0.5:
            lines.append("import m%d" % j)
            available += exports_of[j]
    own = []

    def gen_expr(depth, scope):
        r = rng.random()
        if depth > 0 and r < 0.25:
            return "%s + %s" % (gen_expr(depth - 1, scope), gen_expr(depth - 1, scope))
        fns = [n for n, k in scope if k == "fn"]
        if depth > 0 and fns and r < 0.45:
            return "%s(%s)" % (rng.choice(fns), gen_expr(depth - 1, scope))
        if r < 0.55:
            return str(rng.randint(0, 9))
        if r < 0.65:
            return rng.choice(["true", "false"])
        if scope and r < 0.9:
            return rng.choice(scope)[0]
        return "undefined_name"

    for _ in range(rng.randint(1, 5)):
        nm = "v%d" % len(own)
        kind = rng.random()
        if kind < 0.45:
            ann = rng.choice([None, "Int", "Bool"])
            expr = gen_expr(2, available + own)
            if ann:
                lines.append("let %s: %s = %s" % (nm, ann, expr))
            else:
                lines.append("let %s = %s" % (nm, expr))
            own.append((nm, "int"))
        elif kind < 0.7:
            nm = "f%d" % len(own)
            param = "p"
            ptype = rng.choice(["Int", "Bool"])
            ret = rng.choice(["Int", "Bool"])
            body = gen_expr(2, available + own + [(param, "int")])
            lines.append("fn %s(%s: %s) -> %s = %s" % (nm, param, ptype, ret, body))
            own.append((nm, "fn"))
        else:
            lines.append("let %s = %s" % (nm, gen_expr(2, available + own)))
            own.append((nm, "int"))
    exports_of[idx] = own
    return "\n".join(lines) + "\n"


class TestIncremental(unittest.TestCase):
    def run_project(self, seed):
        rng = random.Random(seed)
        with tempfile.TemporaryDirectory() as tmp:
            proj = os.path.join(tmp, "proj")
            os.mkdir(proj)
            old_cwd = os.getcwd()
            os.chdir(tmp)
            try:
                exports_of = {}
                n = rng.randint(2, 6)
                for i in range(n):
                    with open(os.path.join(proj, "m%d.mt" % i), "w") as fh:
                        fh.write(gen_module(rng, i, exports_of))
                with contextlib.redirect_stdout(io.StringIO()):
                    rc = core.do_load(proj)
                self.assertIn(rc, (0, 1))

                for _step in range(6):
                    i = rng.randrange(n)
                    path = os.path.join(proj, "m%d.mt" % i)
                    if rng.random() < 0.2:
                        # no-op: identical content
                        out = io.StringIO()
                        with contextlib.redirect_stdout(out):
                            rc = core.do_patch(path)
                        self.assertEqual(rc, 0)
                        self.assertEqual(out.getvalue().strip(), "no-op")
                        continue
                    with open(path, "w") as fh:
                        fh.write(gen_module(rng, i, exports_of))
                    before = dict(core.load_state()["modules"])
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        rc = core.do_patch(path)
                    self.assertIn(rc, (0, 1))

                    # 1. Incremental state == full recheck from disk.
                    expected = core.format_all(core.check_all(proj))
                    state = core.load_state()
                    actual = core.format_all(state["modules"])
                    self.assertEqual(actual, expected,
                                     "seed=%d step module m%d" % (seed, i))
                    # 2. Printed diagnostics match the state.
                    printed = [l for l in out.getvalue().splitlines() if l]
                    self.assertEqual(printed, actual)
                    # 3. Exit code reflects diagnostic presence.
                    self.assertEqual(rc, 1 if expected else 0)
                    # 4. Unaffected modules keep byte-identical diagnostics.
                    graph = {m: r["imports"] for m, r in state["modules"].items()}
                    affected = core.transitive_dependents(graph, "m%d" % i)
                    for m, rec in state["modules"].items():
                        if m not in affected and m in before:
                            self.assertEqual(rec["diagnostics"],
                                             before[m]["diagnostics"],
                                             "seed=%d module %s" % (seed, m))
            finally:
                os.chdir(old_cwd)

    def test_random_projects(self):
        for seed in range(30):
            with self.subTest(seed=seed):
                self.run_project(seed)


if __name__ == "__main__":
    unittest.main()
