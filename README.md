# linearchk

A Go library that checks programs of **linear commands** against
borrow rules, and verifies the checker against an exhaustive
finite-state enumerator.

## Command language

```
new x            # create an owner
share r = &x     # shared borrow (any number may coexist)
excl m = &mut x  # exclusive borrow (forbids any other access)
use x            # read through a name
mut m            # write through a name
move y = x       # transfer an owner or a borrow
drop r           # end a lifetime
if { ... } else { ... }   # branches must merge compatibly
```

## Rules enforced

- Shared borrows coexist; an exclusive borrow requires that no other
  borrow of the same owner is live.
- While an exclusive borrow is live, any aliased access through the
  owner (or a second borrow) is a violation.
- Borrows and owners can be transferred with `move`, but a borrowed
  owner cannot move, and a borrow may not outlive its owner.
- At an `if` join, both branches must agree on every live symbol's
  kind and borrow target.

## API

- `Parse(src) ([]Cmd, error)` — parse the command language.
- `Check(prog) []Violation` — path-sensitive analysis; each violation
  carries the offending command path (`[then]`/`[else]` mark branches).
- `Explore(prog) Exploration` — BFS over the finite (pc, state) space;
  enumerates all reachable states and every bad transition/join.

## Tests

`go test ./...` runs unit tests plus a reference-verification suite
that cross-checks `Check` against `Explore` on every straight-line
program up to length 3, every single-`if` program with one-command
branches, and 3000 random nested programs over a small alphabet.
