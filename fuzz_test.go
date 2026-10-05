package streamtext

import (
	"slices"
	"testing"
)

// FuzzApplyMatchesFullDecode checks that any edit batch that passes
// validation produces the same runes and spans as a full re-decode.
func FuzzApplyMatchesFullDecode(f *testing.F) {
	f.Add([]byte("hello \xe4\xb8\xad world"), byte(3), byte(6), []byte("\xf0\x9f\x98"))
	f.Add([]byte{0xed, 0xa0, 0x80, 0x41}, byte(0), byte(4), []byte{0x80})
	f.Fuzz(func(t *testing.T, data []byte, s, e byte, text []byte) {
		if len(data) > 4096 || len(text) > 512 {
			t.Skip()
		}
		doc := NewDocument(data)
		start := int(s) % (len(data) + 1)
		end := int(e) % (len(data) + 1)
		if end < start {
			start, end = end, start
		}
		nd, _, err := doc.Apply(doc.Version(), []Edit{{Start: start, End: end, Text: text}})
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
		wantR, wantS := Decode(nd.Data())
		if !slices.Equal(nd.Runes(), wantR) || !slices.Equal(nd.Spans(), wantS) {
			t.Fatalf("data % x edit [%d,%d)+% x: incremental disagrees with full decode",
				data, start, end, text)
		}
	})
}
