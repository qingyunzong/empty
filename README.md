# evidence-chain

Offline evidence citation-chain verification library and CLI. Node.js 22,
standard library only (`node:crypto`, `node:test`); no dependencies.

## Script language

```
evidence E1            # atomic evidence commit
rule Step              # inference rule commit
alias P = E1 & E2      # alias, visible in current block and children only
claim C1 = E1 |> Step          # derive: apply rule Step to E1
claim C2 = (C1 & E2) |> Step   # conjunction + derivation
claim C3 = C2 requires E3      # requirement
{ ... }                # nested scope; aliases do not escape
```

Operators (Pratt parser, ascending precedence): `requires` < `|>` < `&`,
parentheses, `#` comments. Static types: `evidence`, `rule`, `claim`.
Duplicate declarations in one scope are rejected; aliases are visible only
in their own block and nested blocks.

## Certificates

Every declaration becomes a commit carrying its normalized term (aliases
expanded, `&` flattened and sorted), the parent certificate and a scope
hash. Certificates are HMAC-SHA256 over the canonical payload, forming a
hash-linked chain. Verification recursively rechecks parent links, static
types and signatures (timing-safe comparison).

## Revocation

`Session.revoke(name)` invalidates every claim whose transitive evidence
closure contains `name`. `undo()` restores a revocation, `redo()` replays
it, and any new operation clears the redo stack.

## CLI

```
node cli.js certify     <script.ev> --key K [--out doc.json]
node cli.js verify      <script.ev> --key K [--revoke NAME]...
node cli.js verify-cert <doc.json>  --key K [--revoke NAME]...
```

Success prints a JSON verdict on stdout (exit 0). Failures (parse/type/
scope errors, broken parent links, bad signatures, invalid verdicts) print
error text on stderr and exit 1.

## Tests

```
node --test
```
