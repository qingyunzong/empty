# scoper

Lexical scope resolution over a parsed AST JSON tree, plus a CLI.
Pure Python 3.11 standard library; tests use `unittest`.

## Semantics

Input is a parsed AST JSON tree built from these node types:

| Node     | Shape |
|----------|-------|
| `block`  | `{"type":"block","stmts":[...]}` |
| `let`    | `{"type":"let","name":...,"span":...,"init":<expr>}` |
| `const`  | `{"type":"const","name":...,"span":...,"init":<expr>}` |
| `fn`     | `{"type":"fn","name":...,"span":...,"params":[{"name","span"}],"body":<block>}` |
| `use`    | `{"type":"use","name":...,"span":...}` |
| `assign` | `{"type":"assign","name":...,"span":...,"value":<expr>}` |

`<expr>` is a `use` node or `{"type":"lit","value":...}`. Spans are
opaque JSON values echoed back in the output.

Resolution rules:

1. Builtins (`print`, `len`, ...) and function parameters are bound on
   scope entry.
2. `let`/`const` have a TDZ: they are hoisted into their block (and
   therefore shadow outer bindings) but are unusable until their
   declaration statement is reached.
3. `fn` declarations are resolvable from the start of their block, but
   their bodies are resolved lazily at the definition point, so a body
   sees exactly the bindings active where the `fn` statement sits.
4. `use` resolves to the nearest visible binding; `assign` to a
   non-writable `const` (or builtin) raises `AssignConst`.
5. Undefined names, duplicate definitions in one scope, and TDZ accesses
   raise `ScopeError` with `name`, `kind`, `use_span`, `def_span`.

Output record (`resolved.json`):

- `defs`: every binding as `{"def_id","name","kind","span"}`.
- `uses`: every `use` as `{"name","span","def_id":N}` or
  `{"name","span","builtin":true}`.
- `assigns`: every `assign` as `{"name","span","def_id":N}`.
- `functions`: every `fn` as `{"name","def_id","captures":[...]}` where
  `captures` is the sorted list of outer `def_id`s the body (including
  nested bodies, transitively) references.

## CLI

```
python -m scoper src.scp --emit resolved.json
```

- Success: writes `resolved.json`, exit code 0.
- Scope failure (`ScopeError`/`AssignConst`): prints the error as JSON to
  stderr, exit code 5, and `resolved.json` is not created.
- Unreadable/invalid input: exit code 2.

Example error output:

```json
{"error": {"kind": "Undefined", "name": "nope",
           "use_span": {"line": 1, "col": 0}, "def_span": null}}
```

## Tests

```
python -m unittest discover -s tests -v
```

Coverage includes the acceptance cases:

- **A** 300 random small scope trees compared against an independent
  environment-stack reference implementation (`tests/reference.py`).
- **B** `{let x=1; {use x; let x=2}}` — the inner `use x` raises TDZ.
- **C** `fn f(){use g} fn g(){use f}` — both resolve; `f` captures `g`
  and `g` captures the outer `f`.
- **D** `assign` to a `const` fails with `AssignConst`; duplicate `let`
  in one block fails with `Duplicate`.

## Recorded run (this workspace, Python 3.14.4)

```
$ python -m unittest discover -s tests -v
test_b_inner_use_before_let_is_tdz ... ok
test_body_let_shadows_param_after_declaration ... ok
test_builtin_use ... ok
test_c_mutual_fn_resolution_and_capture ... ok
test_d_assign_to_const_fails ... ok
test_d_duplicate_let_same_block_fails ... ok
test_fn_body_delayed_to_definition_point ... ok
test_fn_name_usable_before_its_statement ... ok
test_nested_capture_propagates ... ok
test_params_bound_on_entry ... ok
test_shadowing_inner_block_ok ... ok
test_use_before_shadowing_let_in_body_is_tdz ... ok
test_cli_assign_const_exit_5_no_output ... ok
test_cli_scope_error_exit_5_no_output ... ok
test_cli_success_emits_resolved ... ok
test_random_trees_match_reference ... ok
----------------------------------------------------------------------
Ran 16 tests in 2.126s

OK
```

CLI smoke run on a program with `let x`, `fn f(p){use x; use print}`:
exit 0, `resolved.json` maps `use x -> def_id 0`, `use print ->
builtin:true`, and `f.captures == [0]`. A program using an undefined
name exits with code 5, prints the `Undefined` error JSON, and creates
no output file.
