# pathnorm

`pathnorm` normalizes slash-separated paths using a **caller-supplied
Unicode folding map** and an **explicit case rule**. Normalization is fully
deterministic and never depends on platform-local rules (no OS case
sensitivity, no locale, no filesystem behavior). Only the Go standard
library is used.

## Pipeline

For each path segment, normalization applies, in order:

1. **Case rule** — `CasePreserve`, `CaseLower`, or `CaseUpper`, using
   Unicode simple case mapping (`unicode.ToLower` / `unicode.ToUpper`),
   a fixed per-rune table independent of locale and platform.
2. **Folding map** — `FoldingMap` (`map[rune]string`) substitutes each
   rune; replacements may delete (empty string) or expand (multi-rune).

`Interpret` in `mapping.go` is the mapping interpreter: the deliberately
simple reference implementation of this pipeline. `Normalizer` output is
cross-checked against it (`TestNormalizeAgainstInterpreter`).

## Rules

- **Empty segments rejected** — leading/trailing/doubled `/` fail with
  `ErrEmptySegment` (wrapped in `*PathError`, which preserves the original
  path and the offending segment as evidence).
- **Upward segments rejected** — any `..` segment fails with
  `ErrUpwardSegment`. `.` and lookalikes (`...`, `..a`) are allowed.
- **Batch collision ⇒ whole batch rejected** — `NormalizeBatch` fails the
  entire batch with `*CollisionError` when two *different* original paths
  normalize to the same name. Repeating the identical original is not a
  collision.
- **Original-name evidence** — a successful batch returns `BatchResult`
  with `Records` (original → normalized, input order) and `Evidence`
  (normalized → original). On collision, `CollisionError` carries the
  normalized name and both conflicting originals.

## Example

```go
folding := pathnorm.FoldingMap{'Ａ': "a", 'é': "e", 'ß': "ss"}
n := pathnorm.New(folding, pathnorm.CaseLower)

res, err := n.NormalizeBatch([]string{"Ａ/b", "Café"})
// res.Evidence == map[string]string{"a/b": "Ａ/b", "cafe": "Café"}

_, err = n.NormalizeBatch([]string{"Ａ", "A"})
// err is *pathnorm.CollisionError: "Ａ" and "A" both normalize to "a";
// the whole batch is rejected.
```

## Test results (actual)

`go test ./...` run with go1.27.1 linux/amd64 on 2026-10-05:

```
ok  	pathnorm	0.017s
```

`go vet ./...` passes with no findings.
