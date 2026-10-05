package streamtext

import (
	"bytes"
	"math/rand"
	"slices"
	"testing"
)

func mustApply(t *testing.T, d *Document, edits ...Edit) (*Document, *Delta) {
	t.Helper()
	nd, delta, err := d.Apply(d.Version(), edits)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	return nd, delta
}

func checkAgainstFullDecode(t *testing.T, d *Document) {
	t.Helper()
	wantR, wantS := Decode(d.Data())
	if !slices.Equal(d.Runes(), wantR) || !slices.Equal(d.Spans(), wantS) {
		t.Fatalf("document disagrees with full decode of % x", d.Data())
	}
}

func TestApplyBasic(t *testing.T) {
	doc := NewDocument([]byte("hello world"))
	nd, delta := mustApply(t, doc, Edit{Start: 6, End: 11, Text: []byte("gopher")})

	if string(nd.Data()) != "hello gopher" {
		t.Fatalf("data %q", nd.Data())
	}
	checkAgainstFullDecode(t, nd)

	if delta.ByteStart != 6 || delta.ByteEnd != 11 || delta.NewStart != 6 || delta.NewEnd != 12 {
		t.Fatalf("delta region %+v", delta)
	}
	if string(delta.Removed) != "world" || string(delta.Inserted) != "gopher" {
		t.Fatalf("delta content %+v", delta)
	}
	if delta.NetRunes != 1 || delta.Shift != 1 || delta.Version != 1 {
		t.Fatalf("delta %+v", delta)
	}

	// The old version keeps its mapping for readers.
	if doc.Version() != 0 || string(doc.Data()) != "hello world" {
		t.Fatalf("old document mutated")
	}
	if doc.Spans()[6] != (Span{6, 7}) {
		t.Fatalf("old mapping lost: %v", doc.Spans()[6])
	}
}

func TestCrossEdgeRepair(t *testing.T) {
	// Dangling bytes E4 B8 decode as two replacements; appending AD
	// repairs them into 中 (U+4E2D).
	doc := NewDocument([]byte{0xE4, 0xB8})
	if !slices.Equal(doc.Runes(), []rune{Replacement, Replacement}) {
		t.Fatalf("initial %U", doc.Runes())
	}
	nd, delta := mustApply(t, doc, Edit{Start: 2, End: 2, Text: []byte{0xAD}})
	if !slices.Equal(nd.Runes(), []rune{'\u4e2d'}) || nd.Spans()[0] != (Span{0, 3}) {
		t.Fatalf("repaired (%U, %v)", nd.Runes(), nd.Spans())
	}
	if delta.NetRunes != -1 || len(delta.Removed) != 2 || len(delta.Inserted) != 1 {
		t.Fatalf("delta %+v", delta)
	}

	// Appending one byte completes a four-byte sequence across the edge.
	doc4 := NewDocument([]byte{'a', 0xF0, 0x90, 0x80})
	nd4, delta4 := mustApply(t, doc4, Edit{Start: 4, End: 4, Text: []byte{0x80}})
	if !slices.Equal(nd4.Runes(), []rune{'a', 0x10000}) {
		t.Fatalf("repaired %U", nd4.Runes())
	}
	if delta4.NetRunes != -2 {
		t.Fatalf("delta %+v", delta4)
	}
	checkAgainstFullDecode(t, nd4)
}

func TestEditBreaksSequence(t *testing.T) {
	doc := NewDocument([]byte{0xE4, 0xB8, 0xAD})           // 中
	nd, delta := mustApply(t, doc, Edit{Start: 1, End: 2}) // delete middle byte
	if !slices.Equal(nd.Runes(), []rune{Replacement, Replacement}) {
		t.Fatalf("got %U", nd.Runes())
	}
	if delta.ByteStart != 0 || !slices.Equal(delta.Removed, []rune{'\u4e2d'}) {
		t.Fatalf("delta %+v", delta)
	}
	checkAgainstFullDecode(t, nd)
}

func TestOverlapRejected(t *testing.T) {
	doc := NewDocument([]byte("abcdef"))
	if _, _, err := doc.Apply(0, []Edit{{Start: 1, End: 4}, {Start: 3, End: 5}}); err != ErrOverlap {
		t.Fatalf("err %v", err)
	}
	if _, _, err := doc.Apply(0, []Edit{{Start: 2, End: 4}, {Start: 0, End: 3}}); err != ErrOverlap {
		t.Fatalf("unsorted overlap: err %v", err)
	}
	if doc.Version() != 0 || string(doc.Data()) != "abcdef" {
		t.Fatalf("document changed after rejected batch")
	}
	// Adjacent edits do not overlap and apply in one batch.
	nd, _ := mustApply(t, doc, Edit{Start: 0, End: 1, Text: []byte("X")}, Edit{Start: 1, End: 2, Text: []byte("Y")})
	if string(nd.Data()) != "XYcdef" {
		t.Fatalf("data %q", nd.Data())
	}
}

func TestVersionConflict(t *testing.T) {
	doc := NewDocument([]byte("abc"))
	nd, _ := mustApply(t, doc, Edit{Start: 0, End: 1, Text: []byte("z")})
	// Replaying against the stale version must not take effect.
	if _, _, err := nd.Apply(doc.Version(), []Edit{{Start: 0, End: 1, Text: []byte("q")}}); err != ErrVersionConflict {
		t.Fatalf("err %v", err)
	}
	if string(nd.Data()) != "zbc" || nd.Version() != 1 {
		t.Fatalf("document changed after conflict")
	}
	if _, _, err := doc.Apply(9, nil); err != ErrVersionConflict {
		t.Fatalf("err %v", err)
	}
}

func TestRangeValidation(t *testing.T) {
	doc := NewDocument([]byte("abc"))
	for _, e := range []Edit{{Start: -1}, {Start: 2, End: 1}, {Start: 0, End: 4}} {
		if _, _, err := doc.Apply(0, []Edit{e}); err != ErrRange {
			t.Fatalf("%+v: err %v", e, err)
		}
	}
}

// TestRandomEditsVsFullDecode applies random non-overlapping edit batches
// to random (partly invalid) byte strings and checks the incremental
// result against a full re-decode, including minimality of the affected
// region and migration of the untouched tail.
func TestRandomEditsVsFullDecode(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	randomBytes := func(n int) []byte {
		b := make([]byte, 0, n)
		for len(b) < n {
			switch rng.Intn(4) {
			case 0: // valid multi-byte sequence
				var buf [4]byte
				r := rune(0x20 + rng.Intn(0x300))
				if rng.Intn(3) == 0 {
					r = rune(0x10000 + rng.Intn(0x1000))
				}
				b = append(b, buf[:copy(buf[:], string(r))]...)
			case 1: // raw byte, often a continuation/lead to create breakage
				b = append(b, byte(0x80+rng.Intn(0x80)))
			default:
				b = append(b, byte(rng.Intn(256)))
			}
		}
		return b[:n]
	}

	for iter := 0; iter < 500; iter++ {
		n := rng.Intn(80)
		data := randomBytes(n)
		doc := NewDocument(data)

		m := 1 + rng.Intn(4)
		var edits []Edit
		cursor := 0
		for i := 0; i < m; i++ {
			start := cursor
			if cursor < n {
				start = cursor + rng.Intn(n-cursor+1)
			}
			end := start
			if start < n {
				end = start + rng.Intn(n-start+1)
			}
			edits = append(edits, Edit{Start: start, End: end, Text: randomBytes(rng.Intn(12))})
			cursor = end
		}

		nd, delta, err := doc.Apply(doc.Version(), edits)
		if err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}

		// Expected new bytes.
		var want bytes.Buffer
		pos := 0
		for _, e := range edits {
			want.Write(data[pos:e.Start])
			want.Write(e.Text)
			pos = e.End
		}
		want.Write(data[pos:])
		if !bytes.Equal(nd.Data(), want.Bytes()) {
			t.Fatalf("iter %d: data mismatch", iter)
		}

		// Incremental result must equal a full re-decode.
		checkAgainstFullDecode(t, nd)

		// Net code point difference is consistent.
		if len(nd.Runes())-len(doc.Runes()) != delta.NetRunes {
			t.Fatalf("iter %d: NetRunes %d", iter, delta.NetRunes)
		}
		if delta.Shift != len(nd.Data())-len(doc.Data()) {
			t.Fatalf("iter %d: Shift %d", iter, delta.Shift)
		}

		// Minimality: the affected region starts no more than 3 bytes
		// before the first edit and ends no more than 6 bytes past the
		// last edit (span repair plus cross-edge completion).
		first, last := edits[0], edits[len(edits)-1]
		if delta.ByteStart > first.Start || delta.ByteStart < first.Start-3 {
			t.Fatalf("iter %d: ByteStart %d, first edit %d", iter, delta.ByteStart, first.Start)
		}
		if delta.ByteEnd < last.End || delta.ByteEnd > last.End+6 {
			t.Fatalf("iter %d: ByteEnd %d, last edit end %d", iter, delta.ByteEnd, last.End)
		}

		// Spans before the affected region are untouched.
		oldSpans, newSpans := doc.Spans(), nd.Spans()
		prefix := 0
		for prefix < len(oldSpans) && oldSpans[prefix].End <= delta.ByteStart {
			if newSpans[prefix] != oldSpans[prefix] {
				t.Fatalf("iter %d: prefix span %d migrated", iter, prefix)
			}
			prefix++
		}
		// Spans after the affected region migrate by exactly Shift.
		suffix := 0
		for suffix < len(oldSpans) && oldSpans[len(oldSpans)-1-suffix].Start >= delta.ByteEnd {
			old := oldSpans[len(oldSpans)-1-suffix]
			got := newSpans[len(newSpans)-1-suffix]
			if got != (Span{old.Start + delta.Shift, old.End + delta.Shift}) {
				t.Fatalf("iter %d: suffix span %v -> %v, shift %d", iter, old, got, delta.Shift)
			}
			suffix++
		}
		// Every old span is either outside the region or inside it.
		if prefix+suffix > len(oldSpans) {
			t.Fatalf("iter %d: span bookkeeping overlap", iter)
		}
	}
}

// TestOldVersionsStayValid keeps a chain of versions and verifies that
// every old mapping still matches a full decode of its own bytes.
func TestOldVersionsStayValid(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	doc := NewDocument([]byte("the quick brown fox"))
	var versions []*Document
	for i := 0; i < 20; i++ {
		versions = append(versions, doc)
		n := len(doc.Data())
		start := rng.Intn(n + 1)
		end := start + rng.Intn(n-start+1)
		nd, _, err := doc.Apply(doc.Version(), []Edit{{Start: start, End: end, Text: []byte("Ω")}})
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
		doc = nd
	}
	for i, v := range versions {
		wantR, wantS := Decode(v.Data())
		if !slices.Equal(v.Runes(), wantR) || !slices.Equal(v.Spans(), wantS) {
			t.Fatalf("version %d mapping corrupted", i)
		}
		if v.Version() != uint64(i) {
			t.Fatalf("version %d has %d", i, v.Version())
		}
	}
}
