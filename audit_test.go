package auditlog

import (
	"bytes"
	"testing"
)

func TestMergeRangesAcrossChunkBoundary(t *testing.T) {
	// A secret spanning a chunk boundary produces one range per chunk;
	// the adjacent ranges must coalesce into a single range.
	payload := []byte("header-SECRETKEY-part2-trailer")
	chunkSize := 10
	perChunk := [][]Range{
		{{Start: 7, End: 10}}, // "SEC" in chunk 0
		{{Start: 0, End: 8}},  // "RETKEY-p" in chunk 1
	}
	abs, err := ChunkRanges(len(payload), chunkSize, perChunk)
	if err != nil {
		t.Fatalf("ChunkRanges: %v", err)
	}
	merged, err := MergeRanges(abs, len(payload))
	if err != nil {
		t.Fatalf("MergeRanges: %v", err)
	}
	if len(merged) != 1 || merged[0] != (Range{Start: 7, End: 18}) {
		t.Fatalf("expected single merged range [7,18), got %v", merged)
	}
}

func TestMergeRangesOverlappingAndUnsorted(t *testing.T) {
	merged, err := MergeRanges([]Range{{8, 12}, {2, 5}, {4, 9}, {20, 22}}, 30)
	if err != nil {
		t.Fatalf("MergeRanges: %v", err)
	}
	want := []Range{{2, 12}, {20, 22}}
	if len(merged) != len(want) {
		t.Fatalf("got %v, want %v", merged, want)
	}
	for i := range want {
		if merged[i] != want[i] {
			t.Fatalf("got %v, want %v", merged, want)
		}
	}
}

func TestInvalidRangesRejected(t *testing.T) {
	cases := []struct {
		name   string
		ranges []Range
	}{
		{"negative start", []Range{{-1, 3}}},
		{"end before start", []Range{{5, 2}}},
		{"end beyond payload", []Range{{0, 11}}},
		{"start beyond payload", []Range{{11, 11}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := MergeRanges(tc.ranges, 10); err == nil {
				t.Fatalf("MergeRanges(%v) accepted invalid range", tc.ranges)
			}
			if _, _, err := Redact(make([]byte, 10), tc.ranges); err == nil {
				t.Fatalf("Redact(%v) accepted invalid range", tc.ranges)
			}
		})
	}
}

func TestRedactKeepsOutsideBytesUnchanged(t *testing.T) {
	original := []byte("user=alice password=hunter2 role=admin")
	ranges := []Range{{11, 28}} // "password=hunter2"
	redacted, merged, err := Redact(original, ranges)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	if err := CheckOutsideUnchanged(original, redacted, merged); err != nil {
		t.Fatalf("CheckOutsideUnchanged: %v", err)
	}
	if bytes.Contains(redacted, []byte("hunter2")) {
		t.Fatal("redacted payload still contains the secret")
	}
	// Redact must not mutate its input.
	if !bytes.Equal(original, []byte("user=alice password=hunter2 role=admin")) {
		t.Fatal("Redact mutated the original payload")
	}
	// A tampered copy must be detected.
	tampered := append([]byte(nil), redacted...)
	tampered[0] ^= 0xff
	if err := CheckOutsideUnchanged(original, tampered, merged); err == nil {
		t.Fatal("CheckOutsideUnchanged missed an out-of-range modification")
	}
}

func TestChainReplayFromRedactedRecords(t *testing.T) {
	var records []Record
	var prev [32]byte
	payloads := [][]byte{
		[]byte("tx1 secret=alpha"),
		[]byte("tx2 secret=beta"),
		[]byte("tx3 no-secret"),
	}
	ranges := [][]Range{{{9, 14}}, {{9, 13}}, nil}
	for i, p := range payloads {
		redacted, merged, err := Redact(p, ranges[i])
		if err != nil {
			t.Fatalf("Redact: %v", err)
		}
		rec := NewRecord(uint64(i), prev, Digest(p), redacted, merged)
		records = append(records, *rec)
		prev = rec.Hash
	}
	// The chain replays from redacted data alone.
	if err := VerifyChain(records); err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	// Each record still validates against its original payload.
	for i := range records {
		if err := VerifyRecordAgainstOriginal(&records[i], payloads[i]); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	// Tampering with any stored byte breaks the chain.
	tampered := append([]Record(nil), records...)
	tampered[1].Payload[0] ^= 0x01
	if err := VerifyChain(tampered); err == nil {
		t.Fatal("VerifyChain accepted a tampered record")
	}
}

func TestEmptyAndZeroRanges(t *testing.T) {
	merged, err := MergeRanges([]Range{{3, 3}}, 10)
	if err != nil {
		t.Fatalf("MergeRanges: %v", err)
	}
	if len(merged) != 0 {
		t.Fatalf("empty range should be dropped, got %v", merged)
	}
	redacted, merged, err := Redact([]byte("plain"), nil)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	if string(redacted) != "plain" || len(merged) != 0 {
		t.Fatalf("no-range redact altered payload: %q %v", redacted, merged)
	}
}
