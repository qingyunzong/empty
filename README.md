# logrec

Log record assembler (Go standard library only). A record is one **start
line** plus its **continuation lines**, classified by a finite rule table.
Input may be fed in arbitrary byte chunks; the final line need not end
with a newline.

## Library

```go
p, _ := logrec.New(logrec.Config{
    Rules: []logrec.Rule{
        {Prefix: "ERROR", Kind: logrec.Start},
        {Prefix: " ", Kind: logrec.Continuation},
    },
    MaxLineBytes: 1 << 20,
})
p.Write(chunk) // any chunking
p.Close()
recs := p.Records()
diags := p.Diagnostics()
```

- **Rule table**: at most `logrec.MaxRules` (64) prefix rules, first match
  wins. With rules, unmatched lines are continuations. With no rules,
  lines starting with a space or tab are continuations, all others start
  a record.
- **Orphan continuation**: a continuation line with no open record is
  dropped and reported as an `orphan-continuation` diagnostic covering
  the line's byte range.
- **Oversize line**: a line longer than `MaxLineBytes` (terminator
  excluded; 0 = unlimited) is discarded together with every following
  non-start line. The discarded byte range, up to the next start line or
  end of input, is reported as an `oversize-discard` diagnostic.
- **Offsets**: `Record.Offset` and `Diagnostic.Start`/`End` are byte
  offsets into the input (`End` exclusive, ranges include line
  terminators). `Line` is the 1-based line number.

## CLI

```
logrec [-max-line N] [-rule start:PREFIX] [-rule cont:PREFIX] [file...]
```

Reads standard input or the named files and prints records and
diagnostics as JSON lines ordered by byte offset, e.g.:

```
$ printf '  stray\nERROR x\n  ctx\n' | logrec -rule start:ERROR -rule 'cont: '
{"type":"diagnostic","kind":"orphan-continuation","offset":0,"end":8,"line":1}
{"type":"record","offset":8,"line":2,"lines":["ERROR x","  ctx"]}
```

Exit status: 0 clean, 1 diagnostics reported, 2 usage or I/O error.

## Testing

`go test ./...` — includes a chunking invariant: every test input is
parsed one-shot and re-parsed with every fixed chunk size and with random
chunkings; records and diagnostics must be identical.
