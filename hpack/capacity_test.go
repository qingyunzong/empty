package hpack

import (
	"errors"
	"testing"
)

func TestDynamicEntrySizeAndEviction(t *testing.T) {
	// Capacity 64 holds exactly one entry of size 64 (name 16 + value 16 + 32).
	d := newTestDecoder(t, 64)
	enc := newEncoder()

	name := "0123456789abcdef"  // 16 bytes
	value := "fedcba9876543210" // 16 bytes -> entry size 64
	if got := entrySize(name, value); got != 64 {
		t.Fatalf("entrySize = %d, want 64", got)
	}

	block := enc.literal(0x40, 6, 0, name, value, false)
	feedBlock(t, d, block, true)
	if len(d.dyn) != 1 || d.size != 64 {
		t.Fatalf("after insert dyn=%d size=%d, want 1/64", len(d.dyn), d.size)
	}

	// A second fitting entry evicts the oldest (each is exactly the capacity).
	other := enc.literal(0x40, 6, 0, name, "0123456789abcdeZ", false)
	feedBlock(t, d, other, false)
	if len(d.dyn) != 1 || d.size != 64 || d.dyn[0].value != "0123456789abcdeZ" {
		t.Fatalf("after eviction table = %+v size=%d", d.dyn, d.size)
	}
}

func TestOversizedEntryClearsTable(t *testing.T) {
	d := newTestDecoder(t, 64)
	enc := newEncoder()

	// Seed one fitting entry.
	seed := enc.literal(0x40, 6, 0, "k", "v", false) // size 34
	feedBlock(t, d, seed, false)
	if len(d.dyn) != 1 {
		t.Fatalf("seed failed: %+v", d.dyn)
	}

	// Entry size 17 + 17 + 32 = 66 > 64: table is emptied and nothing inserts.
	bigName := "abcdefghijklmnopq"  // 17
	bigValue := "ABCDEFGHIJKLMNOPQ" // 17
	oversized := enc.literal(0x40, 6, 0, bigName, bigValue, false)
	feedBlock(t, d, oversized, false)
	if len(d.dyn) != 0 || d.size != 0 {
		t.Fatalf("oversized entry did not clear table: dyn=%+v size=%d", d.dyn, d.size)
	}

	// The oversized field is still delivered once for the block.
	out := feedBlock(t, d, enc.indexed(2), false)
	assertFields(t, out, []HeaderField{{Name: ":method", Value: "GET"}})
}

func TestTableSizeUpdateBoundaries(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()

	// Seed an entry of size 34 ("k"/"v").
	feedBlock(t, d, enc.literal(0x40, 6, 0, "k", "v", false), false)
	if d.size != 34 {
		t.Fatalf("seed size = %d, want 34", d.size)
	}

	// Leading update shrinking the capacity below the entry forces eviction.
	block := append(tableSizeUpdate(33), enc.indexed(2)...)
	out := feedBlock(t, d, block, true)
	assertFields(t, out, []HeaderField{{Name: ":method", Value: "GET"}})
	if d.cap != 33 || len(d.dyn) != 0 || d.size != 0 {
		t.Fatalf("after shrink cap=%d dyn=%d size=%d", d.cap, len(d.dyn), d.size)
	}

	// Multiple leading updates in one block are allowed; the last one wins.
	multi := append(tableSizeUpdate(100), tableSizeUpdate(50)...)
	multi = append(multi, enc.indexed(4)...)
	out = feedBlock(t, d, multi, false)
	assertFields(t, out, []HeaderField{{Name: ":path", Value: "/"}})
	if d.cap != 50 {
		t.Fatalf("cap = %d, want 50", d.cap)
	}
}

func TestTableSizeUpdateRejectedAfterStart(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()

	// Indexed field first, then a size update: the update must poison the
	// decoder even though the block prefix is otherwise well formed.
	block := append(enc.indexed(2), tableSizeUpdate(100)...)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Write(block); err == nil {
		t.Fatal("expected error for size update after block start")
	} else if !errors.Is(err, ErrCompression) {
		t.Fatalf("error %v is not a compression error", err)
	}
	if !d.Failed() {
		t.Fatal("decoder must be permanently failed")
	}
	// No fields are delivered for a block that fails partway through.
	if _, err := d.EndHeaderBlock(); !errors.Is(err, ErrCompression) {
		t.Fatalf("EndHeaderBlock after failure = %v, want compression error", err)
	}
}

func TestTableSizeUpdateAboveLimit(t *testing.T) {
	d := newTestDecoder(t, 100)
	block := tableSizeUpdate(101)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Write(block); err == nil || !errors.Is(err, ErrCompression) {
		t.Fatalf("Write = %v, want compression error", err)
	}
	if d.cap != 100 {
		t.Fatalf("cap changed to %d after rejected update", d.cap)
	}
}

func TestSetMaxDynamicTableSizeEvicts(t *testing.T) {
	d := newTestDecoder(t, 4096)
	enc := newEncoder()
	feedBlock(t, d, enc.literal(0x40, 6, 0, "k", "v", false), false)

	if err := d.SetMaxDynamicTableSize(33); err != nil {
		t.Fatal(err)
	}
	if d.maxCap != 33 || len(d.dyn) != 0 || d.size != 0 {
		t.Fatalf("SetMaxDynamicTableSize did not evict: cap=%d dyn=%d", d.maxCap, len(d.dyn))
	}
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	if err := d.SetMaxDynamicTableSize(10); !errors.Is(err, ErrInBlock) {
		t.Fatalf("in-block SetMax = %v, want ErrInBlock", err)
	}
}
