package hpack

import (
	"errors"
	"testing"
)

func newTestDecoder(t *testing.T, cap int) *Decoder {
	t.Helper()
	d, err := NewDecoder(rfcStaticTable(), rfcHuffmanTable(), cap)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	return d
}

// feedBlock runs a full block, optionally splitting input at every possible
// byte boundary to exercise cross-chunk representations.
func feedBlock(t *testing.T, d *Decoder, block []byte, split bool) []HeaderField {
	t.Helper()
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatalf("BeginHeaderBlock: %v", err)
	}
	if !split {
		if _, err := d.Write(block); err != nil {
			t.Fatalf("Write: %v", err)
		}
	} else {
		for i := 0; i < len(block); i++ {
			if _, err := d.Write(block[i : i+1]); err != nil {
				t.Fatalf("Write byte %d: %v", i, err)
			}
		}
	}
	out, err := d.EndHeaderBlock()
	if err != nil {
		t.Fatalf("EndHeaderBlock: %v", err)
	}
	return out
}

func assertFields(t *testing.T, got, want []HeaderField) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("field count = %d, want %d (got %v, want %v)", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("field %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestStaticTableIndexed(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()
	block := append(enc.indexed(2), enc.indexed(4)...) // :method GET, :path /
	out := feedBlock(t, d, block, false)
	assertFields(t, out, []HeaderField{
		{Name: ":method", Value: "GET"},
		{Name: ":path", Value: "/"},
	})
}

func TestIndexingTransitions(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()

	// First block: incremental literal with a literal name, Huffman value.
	lit := enc.literal(0x40, 6, 0, "custom-key", "custom-value", true)
	out := feedBlock(t, d, lit, true)
	assertFields(t, out, []HeaderField{{Name: "custom-key", Value: "custom-value"}})

	// The new entry is dynamic index 62 (61 static + 1) and survives blocks.
	if len(d.dyn) != 1 || d.dyn[0].name != "custom-key" {
		t.Fatalf("dynamic table = %+v, want single custom-key entry", d.dyn)
	}
	block2 := enc.indexed(62)
	out = feedBlock(t, d, block2, false)
	assertFields(t, out, []HeaderField{{Name: "custom-key", Value: "custom-value"}})

	// Incremental entry that references a static name (index 1, :authority)
	// then supplies a new value; afterwards the dynamic copy is index 62.
	lit2 := enc.literal(0x40, 6, 1, "", "example.com", false)
	out = feedBlock(t, d, lit2, false)
	assertFields(t, out, []HeaderField{{Name: ":authority", Value: "example.com"}})
	if got := d.dyn[0]; got.name != ":authority" || got.value != "example.com" {
		t.Fatalf("newest dynamic = %+v", got)
	}
	out = feedBlock(t, d, enc.indexed(62), false)
	assertFields(t, out, []HeaderField{{Name: ":authority", Value: "example.com"}})

	// Non-indexing and never-indexed literals are emitted but never inserted.
	before := len(d.dyn)
	noIdx := enc.literal(0x00, 4, 0, "x-trace", "abc", false)
	neverIdx := enc.literal(0x10, 4, 0, "x-debug", "1", true)
	out = feedBlock(t, d, append(noIdx, neverIdx...), false)
	assertFields(t, out, []HeaderField{
		{Name: "x-trace", Value: "abc"},
		{Name: "x-debug", Value: "1"},
	})
	if len(d.dyn) != before {
		t.Fatalf("non-indexing literal mutated dynamic table: %d -> %d", before, len(d.dyn))
	}
}

func TestOutOfRangeIndexPoisons(t *testing.T) {
	d := newTestDecoder(t, 4096)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	// Index 100 far exceeds the 61 static entries and empty dynamic table.
	if _, err := d.Write([]byte{0xff, 0x00}); err == nil {
		t.Fatal("expected compression error for out-of-range index")
	} else if !errors.Is(err, ErrCompression) {
		t.Fatalf("error %v does not match ErrCompression", err)
	}
	if !d.Failed() {
		t.Fatal("decoder must be permanently failed")
	}
	if err := d.BeginHeaderBlock(); !errors.Is(err, ErrCompression) {
		t.Fatalf("reuse after failure returned %v, want ErrCompression", err)
	}
}
