# exp-dsl

Offline, single-machine Node.js 22 library + CLI for incremental parsing of
experiment parameters and raw observations. Standard library only; tests use
`node:test`.

## DSL

```
experiment outer {          # nested scopes; inner shadows outer
  let rate = 1;             # parameter binding (Pratt-parsed expression)
  let note = `raw (obs)`;   # backtick raw observation, literal chars kept
  experiment inner {
    let rate = 2;
    override rate = 9;      # corrects the nearest existing binding only
  }
}
```

The lexer switches between three modes: code, raw observation (backticks),
and `#` line comments. Expressions support numbers, raw observations, name
references, `+ - * /`, parentheses, and unary minus.

## Snapshots

Each `createSnapshot` / `correct` call produces an immutable snapshot with a
`version` and `parentVersion`. `correct(snapshot, name, expr, scope?)`
incrementally replaces one existing binding (path-copying the scope chain);
the parent snapshot is unchanged and all versions coexist. Values are
evaluated lazily with a per-snapshot cache, so dependents see corrected
values in the child while the parent keeps its own.

Errors (exit code 1 in the CLI): unknown name, `override`/`correct` of an
undefined binding, unterminated raw observation.

## CLI

```
node cli.js parse <file.dsl> [--scope a.b.c]
node cli.js resolve <file.dsl> <name> [--scope a.b.c]
node cli.js correct <file.dsl> <name> <expr> [--scope a.b.c]
```

## Test

```
node --test
```

See `run-record.txt` for the recorded run.
