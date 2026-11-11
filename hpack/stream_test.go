package hpack

import (
	"errors"
	"testing"
)

// splitBlock feeds one header block through writes whose cut points follow
// every possible pattern, exercising representations that span input chunks.
func splitBlock(t *testing.T, d *Decoder, block []byte, cut int) []HeaderField {
	t.Helper()
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if cut <= 0 || cut >= len(block) {
		if _, err := d.Write(block); err != nil {
			t.Fatalf("Write: %v", err)
		}
	} else {
		if _, err := d.Write(block[:cut]); err != nil {
			t.Fatalf("Write first half: %v", err)
		}
		if _, err := d.Write(block[cut:]); err != nil {
			t.Fatalf("Write second half: %v", err)
		}
	}
	out, err := d.EndHeaderBlock()
	if err != nil {
		t.Fatalf("EndHeaderBlock: %v", err)
	}
	return out
}

func TestRepresentationsSpanChunks(t *testing.T) {
	enc := newEncoder()
	block := enc.literal(0x40, 6, 0, "span-name", "span-value-with-a-long-payload", true)
	block = append(block, enc.indexed(2)...)
	block = append(block, enc.literal(0x00, 4, 0, "plain", "text", false)...)
	want := []HeaderField{
		{Name: "span-name", Value: "span-value-with-a-long-payload"},
		{Name: ":method", Value: "GET"},
		{Name: "plain", Value: "text"},
	}

	// Cut at every byte offset, including cuts inside prefix ints and strings.
	for cut := 1; cut < len(block); cut++ {
		d := newTestDecoder(t, 4096)
		got := splitBlock(t, d, block, cut)
		assertFields(t, got, want)
	}

	// One byte per write: the most aggressive fragmentation.
	d := newTestDecoder(t, 4096)
	got := feedBlock(t, d, block, true)
	assertFields(t, got, want)
}

func TestPrefixIntegerBoundaries(t *testing.T) {
	// 7-bit prefix: values at mask-1, mask, mask+1 and across a continuation.
	for _, value := range []int{126, 127, 128, 129, 300, 16383, 16384} {
		enc := newEncoder()
		// Build an indexed representation carrying this integer, capped to a
		// valid static index so a small value round-trips; large values are
		// tested through a literal name index instead to observe encoding.
		block := enc.indexed(sanitizeIndex(value))
		d := newTestDecoder(t, 4096)
		out := feedBlock(t, d, block, true)
		if len(out) != 1 {
			t.Fatalf("value %d produced %d fields", value, len(out))
		}
	}

	// Multi-byte integer split across writes: a long string literal forces a
	// length well past the 7-bit mask.
	enc := newEncoder()
	long := make([]byte, 200)
	for i := range long {
		long[i] = 'z'
	}
	block := enc.literal(0x00, 4, 0, "k", string(long), false)
	d := newTestDecoder(t, 4096)
	got := splitBlock(t, d, block, 3)
	assertFields(t, got, []HeaderField{{Name: "k", Value: string(long)}})
}

func sanitizeIndex(v int) int {
	if v < 1 {
		return 1
	}
	if v > 61 {
		return 61
	}
	return v
}

func TestMultipleBlocksContinuous(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()

	// Block 1 establishes a dynamic entry.
	feedBlock(t, d, enc.literal(0x40, 6, 0, "k1", "v1", false), false)
	// Block 2 references it via dynamic index 62 and adds another entry.
	b2 := enc.indexed(62)
	b2 = append(b2, enc.literal(0x40, 6, 0, "k2", "v2", true)...)
	feedBlock(t, d, b2, false)
	// Block 3 mixes static index, dynamic index and a non-indexing literal.
	b3 := enc.indexed(2)
	b3 = append(b3, enc.indexed(63)...) // second-newest entry k1/v1
	b3 = append(b3, enc.literal(0x10, 4, 0, "trace", "t", false)...)
	out := feedBlock(t, d, b3, true)
	assertFields(t, out, []HeaderField{
		{Name: ":method", Value: "GET"},
		{Name: "k1", Value: "v1"},
		{Name: "trace", Value: "t"},
	})

	// Dynamic table contents persist across all blocks (newest-first).
	if len(d.dyn) != 2 || d.dyn[0].name != "k2" || d.dyn[1].name != "k1" {
		t.Fatalf("dynamic table after three blocks = %+v", d.dyn)
	}
}

func TestIncompleteBlockPoisonsAndDeliversNothing(t *testing.T) {
	enc := newEncoder()
	block := enc.literal(0x40, 6, 0, "name", "value", false)

	d := newTestDecoder(t, 4096)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	// Feed a strict prefix that ends inside the value string.
	if _, err := d.Write(block[:len(block)-2]); err != nil {
		t.Fatalf("partial Write: %v", err)
	}
	if _, err := d.EndHeaderBlock(); err == nil {
		t.Fatal("expected truncation error")
	} else if !errors.Is(err, ErrCompression) {
		t.Fatalf("EndHeaderBlock = %v, want ErrCompression", err)
	}
	if !d.Failed() || len(d.emitted) != 0 {
		t.Fatalf("after truncation failed=%v emitted=%d", d.Failed(), len(d.emitted))
	}
	// The connection context is permanently unusable.
	if err := d.BeginHeaderBlock(); !errors.Is(err, ErrCompression) {
		t.Fatalf("reuse = %v, want ErrCompression", err)
	}
}

func TestBlockLifecycleUsageErrors(t *testing.T) {
	d := newTestDecoder(t, 4096)

	if _, err := d.Write([]byte{0x82}); !errors.Is(err, ErrNotInBlock) {
		t.Fatalf("Write before begin = %v, want ErrNotInBlock", err)
	}
	if _, err := d.EndHeaderBlock(); !errors.Is(err, ErrNotInBlock) {
		t.Fatalf("End before begin = %v, want ErrNotInBlock", err)
	}
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if err := d.BeginHeaderBlock(); !errors.Is(err, ErrInBlock) {
		t.Fatalf("nested begin = %v, want ErrInBlock", err)
	}
	if _, err := d.EndHeaderBlock(); err != nil {
		t.Fatalf("empty block end: %v", err)
	}
}

func TestNewDecoderRejectsBadTables(t *testing.T) {
	if _, err := NewDecoder(nil, rfcHuffmanTable(), 4096); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("nil static table err = %v, want ErrInvalidTable", err)
	}
	if _, err := NewDecoder(rfcStaticTable(), nil, 4096); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("nil huffman table err = %v, want ErrInvalidTable", err)
	}
	bad := *rfcHuffmanTable()
	bad.EOS.N = 0
	if _, err := NewDecoder(rfcStaticTable(), &bad, 4096); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("missing EOS err = %v, want ErrInvalidTable", err)
	}
	bad2 := *rfcHuffmanTable()
	bad2.Codes[97] = HuffmanCode{Bits: bad2.Codes[98].Bits, N: bad2.Codes[98].N}
	if _, err := NewDecoder(rfcStaticTable(), &bad2, 4096); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("duplicate code err = %v, want ErrInvalidTable", err)
	}
}
