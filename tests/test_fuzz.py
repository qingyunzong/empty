"""Acceptance D: random small projects; after every patch the incremental
diagnostic set must equal a full re-check, and diagnostics of modules
outside the re-checked set must keep their ids."""
import os
import random
import tempfile
import unittest

from common import (
    diag_set,
    parse_diagnostics,
    parse_rechecked,
    read_state,
    run_cli,
    state_diag_entries,
    write_file,
    write_project,
)


def gen_module(rng, name, importable):
    """Generate one module source. ``importable`` is a list of
    (module_name, exports) where exports maps name -> ('int',) or
    ('fun', arity).  Imports only reference earlier modules, so the
    generated project is always acyclic."""
    lines = []
    pool = []  # (name, kind) entries visible in this module
    chosen = [m for m, _ in importable if rng.random() < 0.5]
    for mod_name, exports in importable:
        if mod_name in chosen:
            lines.append(f"import {mod_name}")
            pool.extend(exports)

    own = []
    n_decls = rng.randint(1, 4)

    def gen_expr(depth, params):
        visible = params + pool + own
        ints = [n for n, k in visible if k[0] == "int"]
        funs = [(n, k[1]) for n, k in visible if k[0] == "fun"]
        r = rng.random()
        if depth <= 0 or r < 0.3:
            if ints and rng.random() < 0.6:
                return rng.choice(ints)
            return str(rng.randint(0, 9))
        if r < 0.55:
            return f"{gen_expr(depth - 1, params)} + {gen_expr(depth - 1, params)}"
        if r < 0.75 and funs:
            fname, arity = rng.choice(funs)
            if rng.random() < 0.15:  # inject arity error
                arity += rng.choice([-1, 1])
            arity = max(arity, 0)
            args = ", ".join(gen_expr(depth - 1, params) for _ in range(arity))
            return f"{fname}({args})"
        if r < 0.85:
            return f"undefined_{rng.randint(0, 3)}"  # inject E_NAME
        if ints and rng.random() < 0.5:
            return f"({rng.choice(ints)}({gen_expr(depth - 1, params)}))"  # call non-function
        return str(rng.randint(0, 9))

    exports = []
    for i in range(n_decls):
        decl_name = f"{name}_v{i}"
        if rng.random() < 0.4:
            arity = rng.randint(0, 2)
            params = [(f"p{j}", ("int",)) for j in range(arity)]
            sig = ", ".join(f"p{j}: Int" for j in range(arity))
            body = gen_expr(2, [p for p, _ in params])
            lines.append(f"fun {decl_name}({sig}) -> Int = {body}")
            own.append((decl_name, ("fun", arity)))
            exports.append((decl_name, ("fun", arity)))
        else:
            expr = gen_expr(2, [])
            if rng.random() < 0.5:
                lines.append(f"let {decl_name}: Int = {expr}")
            else:
                lines.append(f"let {decl_name} = {expr}")
            own.append((decl_name, ("int",)))
            exports.append((decl_name, ("int",)))
    if rng.random() < 0.1:
        lines.append("let broken: Int =")  # inject E_PARSE
    return "\n".join(lines) + "\n", exports


def gen_project(rng, n_modules):
    files = {}
    module_exports = []  # (name, exports) in dependency-safe order
    for i in range(n_modules):
        name = f"m{i}"
        src, exports = gen_module(rng, name, module_exports)
        files[f"{name}.mm"] = src
        module_exports.append((name, exports))
    return files, module_exports


class TestFuzzIncremental(unittest.TestCase):
    def test_random_projects_incremental_matches_full(self):
        for seed in (7, 23, 91):
            with self.subTest(seed=seed):
                self._run_project(seed)

    def _run_project(self, seed):
        rng = random.Random(seed)
        n_modules = 5
        files, module_exports = gen_project(rng, n_modules)
        with tempfile.TemporaryDirectory() as cwd:
            proj = os.path.join(cwd, "proj")
            write_project(proj, files)

            result = run_cli(["load", "proj"], cwd=cwd)
            self.assertIn(result.returncode, (0, 1), result.stderr)

            for step in range(6):
                target = rng.randrange(n_modules)
                name = f"m{target}"
                # Regenerate the module; imports still only reference
                # earlier modules, so the project stays acyclic.
                new_src, _ = gen_module(rng, name, module_exports[:target])
                path = os.path.join(proj, f"{name}.mm")
                write_file(path, new_src)

                before = read_state(cwd)
                patch = run_cli(["patch", f"proj/{name}.mm"], cwd=cwd)
                self.assertIn(patch.returncode, (0, 1), patch.stderr)
                rechecked = parse_rechecked(patch.stdout)
                patch_diags = parse_diagnostics(patch.stdout)
                # State right after the patch (check below would reassign ids).
                after = read_state(cwd)

                # 1) Incremental diagnostic set == full re-check set.
                check = run_cli(["check"], cwd=cwd)
                self.assertEqual(
                    diag_set(patch_diags),
                    diag_set(parse_diagnostics(check.stdout)),
                    f"seed={seed} step={step} target={name}",
                )
                self.assertEqual(patch.returncode, check.returncode)

                # 2) Modules outside the re-checked set keep their
                #    diagnostics including ids (序号不变).
                for mod in before["modules"]:
                    if mod not in rechecked and mod in after["modules"]:
                        self.assertEqual(
                            state_diag_entries(before, mod),
                            state_diag_entries(after, mod),
                            f"module {mod} changed without being rechecked",
                        )

                # 3) The patched module itself is always re-checked
                #    (unless the patch was a no-op).
                if "no-op" not in patch.stdout:
                    self.assertIn(name, rechecked)


if __name__ == "__main__":
    unittest.main()
