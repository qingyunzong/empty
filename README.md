# macrolib

A small hygienic macro library in pure Go (standard library only).

## Model

- **Parameters**: `(defmacro name (params...) body)` defines a macro;
  the body evaluates to a template (usually built with `list`/`quote`).
- **Caller-first argument evaluation**: each argument is expanded and
  evaluated in the caller environment *before* the macro runs, then
  bound to a parameter.
- **Local definitions**: `let` introduces parallel local bindings, both
  in macro bodies and in generated code.
- **Lexical scoping**: parameters are bound in a frame over the macro's
  *definition* environment, so free variables of the body resolve where
  the macro was defined, not where it is called.
- **Hygiene**: `let`-bound variables in a macro template are renamed to
  fresh symbols during expansion, so macro temporaries cannot capture
  same-named caller locals. Caller-supplied symbols (arguments that
  evaluate to symbols, e.g. `'tmp`) are wrapped in `Injected` and are
  never renamed.
- **Call chain**: the expander tracks the macro expansion stack;
  recursive expansion is rejected with a `RecursionError` carrying the
  full chain (`ma -> mb -> ma`).
- **Step budget**: every expansion step consumes budget. If the budget
  runs out before expansion closes, a `BudgetError` ("unclosed") is
  returned with the current call chain. `Expander.StepsUsed` reports
  the exact number of steps a program needs.

## Layout

- `sexpr.go` — values and parser
- `env.go` — lexical scope frames and builtins
- `eval.go` — evaluator, `Macro` type
- `expand.go` — expander: hygiene, call chain, budget
- `macro_test.go` — tests, including a hand-written scope model check

## Test

```sh
go test ./...
```
