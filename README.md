# rxmatch

A small regular-expression engine and CLI in pure Go (standard library only).

## Pattern syntax

- literals (any byte except `()|*?`; `\` escapes a metacharacter)
- `( ... )` capturing groups, numbered from 1 by opening parenthesis
- `a|b` alternation (并联)
- `x*` star, `x?` question mark (postfix, greedy)

## Match semantics

- **Leftmost-earliest**: the match starts at the smallest possible offset.
- **Longest**: among matches starting there, the longest one wins.
- **Ties** (same span, several parse trees) are broken by choice priority:
  earlier alternation branches win; `*` and `?` prefer consuming.
- **Captures**: a group inside a loop reports its last participating
  iteration; a group that never participated reports `-1, -1`.
- A `*` loop never performs an empty iteration (an iteration matching the
  empty string terminates the loop), matching RE2/Go `regexp` behavior.

## Layout

- `regex/` — the library: parser (`parse.go`), Thompson compiler
  (`compile.go`), Pike VM matcher (`regex.go`), and an independent
  exhaustive backtracking matcher (`exhaustive.go`) used only to
  cross-check the VM in tests.
- `cmd/rxmatch/` — the CLI.

## CLI

```
rxmatch <pattern> <string>
```

Prints the match span and every capture group; exit status 0 on match,
1 on no match, 2 on usage/pattern errors.

```
$ rxmatch '(a|ab)(c|bcd)(d*)' 'abcd'
match: [0,4) "abcd"
$1: [0,1) "a"
$2: [1,4) "bcd"
$3: [4,4) ""
```

## Testing

`go test ./...` runs unit tests plus cross-checks that compare the Pike
VM against the independent exhaustive backtracking implementation on
tricky patterns, hundreds of random patterns, and an exhaustive tiny
grammar, each against many short input strings.
