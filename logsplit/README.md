# logsplit

Escape-aware, stream-oriented log record splitter. Go standard library only.

## Semantics

- **Delimiter**: any non-empty byte string (`NewSplitter` panics on empty).
  Matched left to right, non-overlapping — a self-overlapping delimiter
  such as `aa` splits `aaa` into `["", "a"]`.
- **Escape**: a backslash `\` literalizes the next byte. The pair is
  replaced by that byte in the output record, and the byte can never take
  part in a delimiter match. `\\` yields one literal backslash; `\<delim>`
  embeds the delimiter in the record.
- **Block-tail escape**: escape state persists across `Write` chunks. If a
  chunk ends with `\`, the first byte of the next chunk is literalized.
- **Records** contain unescaped content; delimiters are not included.
  A delimiter containing `\` can never match, because a raw backslash is
  always consumed as an escape introducer.
- **Finish** flushes trailing partial input as the final record; a
  dangling trailing backslash is preserved as a literal backslash.

## API

```go
s := logsplit.NewSplitter([]byte(","))
s.Write(chunk1)          // any chunking; boundaries don't matter
s.Write(chunk2)
recs := s.Drain()        // completed records so far
last := s.Finish()       // final record; splitter is done

all := logsplit.Split(data, []byte(",")) // one-shot helper
```

Internally the splitter runs a KMP automaton over the delimiter so
self-overlapping patterns are handled in O(n) total time.

## Testing

`splitter_test.go` contains an independent whole-string reference
implementation (decode escapes to a token stream, then scan left to
right). The streaming splitter is cross-checked against it:

- byte-by-byte feeding (`TestRandomByteByByte`, fixed cases),
- random chunk sizes (`TestRandomChunkSizes`),
- a dedicated block-tail escape test (`TestBlockTailEscape`).

See `TEST_RESULTS.txt` for the recorded `go test ./...` output.
