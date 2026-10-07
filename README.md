# logparse

Streaming `key=value` log-line parser for Go.

## Syntax

- `key=value` pairs separated by spaces or tabs.
- Values may be double-quoted: `msg="hello world"`.
- Escapes (inside and outside quotes): `\n` `\t` `\r` `\\` `\"` `\'` and
  backslash-space (`\ `) for embedding spaces in bare values.
- Bare key (`verbose`) yields the boolean string `"true"`.
- `key=` yields the empty string.
- Duplicate keys keep every value, in order of appearance
  (`Parser.Values()` returns `map[string][]string`).

## Error quarantine

A malformed token (invalid escape, trailing backslash, unterminated quote,
character after a closing quote, missing key) is quarantined to its
physical line: entries already parsed on that line are kept, the remainder
of the line is skipped, and later lines parse normally. Each `ParseError`
carries the 1-based line number, the byte span `[Start, End)` within the
line, and the raw text of that span.

## Streaming

Feed input in arbitrary chunks with `Parser.Feed`; call `Parser.Close` to
flush a trailing line without a newline. Results are independent of how
the input is chunked (verified by exhaustive chunk-split tests).

## Key aliases

`Config.SetAlias(from, to)` builds a directed mapping. Aliases may chain
(`a->b`, `b->c` resolves `a` to `c`); inserting an edge that would close a
cycle fails with `ErrAliasCycle`. Duplicate detection and `Values()`
grouping operate on the final canonical key.

## Hot reload

`Parser.SetConfig` swaps configuration at line granularity: the new config
applies only to lines whose first byte has not yet been fed, while a line
currently spanning chunks finishes under the rules in effect when it
started. Treat a `Config` handed to a parser as immutable; derive updates
with `Config.Clone`.

## Test

```sh
go test ./...
```
