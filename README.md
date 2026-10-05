# canonenc

Canonical escape encoding for byte strings (Go standard library only).

## Encoding rules

- Must-escape set: control bytes `0x00–0x1F`, DEL `0x7F`, the escape byte
  `0x5C` (`\`) itself, and the record delimiter `0xFF`.
- Escape form: `0x5C` followed by `b XOR 0x20`. The mask keeps every payload
  byte in the safe printable range, so encoded output never contains control
  bytes, the escape byte (except as an introducer), or the delimiter.
- The encoding is canonical: each byte string has exactly one valid encoding.

## Decoding rules

- `ErrNonCanonical`: an escape sequence whose payload decodes to a byte that
  never requires escaping (e.g. `\` + `a`). Rejected immediately, mid-stream.
- `ErrIncomplete`: the stream ends with a dangling escape byte. Distinct from
  illegal input; only raised at end of stream (`Decode` return /
  `StreamDecoder.Close`).
- `StreamDecoder` accepts arbitrary chunk boundaries, including splits between
  the two bytes of an escape sequence.

## Signatures

`Sign`/`Verify` compute HMAC-SHA256 over the **encoded** bytes, so the
signature binds the exact wire form. `VerifyAndDecode` authenticates before
decoding.

## Test results

`go test ./...` (go1.27.1, GOCACHE=/tmp/gocache):

```
--- PASS: TestRoundTripAllBytes
--- PASS: TestEncodedNeverContainsDelimiterOrControlBytes
--- PASS: TestArbitraryChunking
--- PASS: TestDoubleEncodedInput
--- PASS: TestNonCanonicalRejected
--- PASS: TestTruncationVsIllegal
--- PASS: TestSignatureBindsEncodedBytes
PASS
ok  	canonenc/canonenc	0.007s
```

Note: an earlier escape mask of `0x80` was rejected by
`TestEncodedNeverContainsDelimiterOrControlBytes` because `0x7F ^ 0x80 = 0xFF`
emitted the delimiter as an escape payload; the mask was changed to `0x20`.
