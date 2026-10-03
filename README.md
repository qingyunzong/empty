# cnc-pack

Offline CNC program package library and CLI. Node.js 22, standard library only.

A G-code program is split into numbered blocks; every block carries a CRC32.
The index (`<base>.idx`) records the program name, the block range, and the
entry offset; block records live in `<base>.blk`. Both files are written to a
temporary file first and atomically renamed into place — a crash before the
index rename leaves an unindexed tail that readers simply ignore.

Supported G-code subset: `G0`/`G1` moves (modal absolute positions), `#n = expr`
assignments, `IF[..] GOTO n`, `GOTO n`, `N<n>` labels, `M98 P<name>` subprogram
calls, `O<name>` bodies, `M99` return, `M30`/`M2` end, `(...)`/`;` comments.

## CLI

```
node bin/cnc.js encode <program.nc> -o <base> [--block-lines K]
node bin/cnc.js verify <base>
node bin/cnc.js decode <base> [--max-depth D] [--upto K] [--from K] [--state FILE] [--events FILE]
```

- `decode` prints a summary line `{"summary":{"confirmed":N,"next":N,"done":...}}`:
  the confirmed prefix and the next sequence number needed. Already confirmed
  blocks are never re-executed; retransmitted duplicates are deduplicated by
  sequence number.
- `--upto K` / `--from K` simulate interrupted and resumed transmission;
  `--state FILE` persists the decoder (blocks, call stack, variables, program
  counter) across runs, again via tmp-file + rename.

Error codes (exit status in parentheses): `E_CRC` (10) corrupt block,
`E_DEPTH` (11) call nesting beyond `--max-depth`, `E_TARGET` (12) missing
subprogram or label, `E_DUP` (13) conflicting retransmission, `E_FORMAT` (14).

## Tests

```
node --test
```
