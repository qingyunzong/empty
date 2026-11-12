package dataeng

import "testing"

// Same buffer position validated once as one table type cannot be re-read as
// a different schema table type.
func TestSamePositionDifferentTableType(t *testing.T) {
	a, _ := NewTable("A", Field{Name: "x", Kind: KindI32, Slot: 0})
	b, _ := NewTable("B", Field{Name: "y", Kind: KindI32, Slot: 0})
	root, err := NewTable("Root",
		Field{Name: "a", Kind: KindTable, Slot: 0, RefTable: a},
		Field{Name: "b", Kind: KindTable, Slot: 1, RefTable: b},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(96)
	const rvt, rtab, childPos, cvt uint32 = 8, 16, 40, 64
	m.vtable(rvt, 12, 4, 8)
	m.table(rtab, rvt)
	m.ref(rtab+4, childPos)
	m.ref(rtab+8, childPos)
	m.vtable(cvt, 8, 4)
	m.table(childPos, cvt)
	m.i32(childPos+4, 5)
	m.root(rtab)

	if _, err := Open(root, m.buf, Limits{}); err == nil {
		t.Fatal("same position used as two distinct table types must be rejected")
	}
}

// Vtable slots unknown to the schema are only bounds-checked: their field
// widths and types are never inferred, so an odd-width payload is tolerated.
func TestUnknownSlotsNotDereferenced(t *testing.T) {
	root, _ := NewTable("Msg", Field{Name: "id", Kind: KindI32, Slot: 0})
	m := newMem(64)
	const vtPos, tablePos uint32 = 8, 20
	// Three slots; only slot 0 is schema-known. Slot 2 points at offset 9,
	// which would fail i32 alignment if the reader guessed a type.
	m.vtable(vtPos, 16, 4, 0, 9)
	m.table(tablePos, vtPos)
	m.i32(tablePos+4, 11)
	m.u8(tablePos+9, 0xAB)
	m.root(tablePos)

	h, err := Open(root, m.buf, Limits{})
	if err != nil {
		t.Fatalf("unknown slots must not be type-checked: %v", err)
	}
	id, err := h.Get(Step{Field: "id"})
	if err != nil || mustI32(t, id) != 11 {
		t.Fatalf("id=%v err=%v", id, err)
	}
}

// A nonzero vtable slot pointing before the object's 4-byte prefix is damage.
func TestVTableSlotBelowFour(t *testing.T) {
	root, _ := NewTable("Msg", Field{Name: "id", Kind: KindI32, Slot: 1})
	m := newMem(48)
	const vtPos, tablePos uint32 = 8, 20
	m.vtable(vtPos, 12, 2, 4)
	m.table(tablePos, vtPos)
	m.root(tablePos)
	if _, err := Open(root, m.buf, Limits{}); err == nil {
		t.Fatal("nonzero slot offset below 4 must be rejected")
	}
}

// Strings may contain embedded NUL bytes and still must decode as UTF-8.
func TestStringEmbeddedNULAndStrictUTF8(t *testing.T) {
	root, _ := NewTable("Msg", Field{Name: "text", Kind: KindString, Slot: 0})
	payload := "a\x00中"
	m := newMem(80)
	const vtPos, tablePos, strPos uint32 = 8, 20, 32
	m.vtable(vtPos, 8, 4)
	m.table(tablePos, vtPos)
	m.ref(tablePos+4, strPos)
	m.stringAt(strPos, payload)
	m.root(tablePos)

	h, err := Open(root, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	text, err := h.Get(Step{Field: "text"})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := text.StringValue(); !ok || got != payload {
		t.Fatalf("string=%q ok=%v", got, ok)
	}
	if want := uint64(len(payload)); text.RefRange.Len() != 4+want+1 {
		t.Fatalf("string range len=%d", text.RefRange.Len())
	}

	bad := newMem(80)
	bad.vtable(vtPos, 8, 4)
	bad.table(tablePos, vtPos)
	bad.ref(tablePos+4, strPos)
	bad.u32(strPos, 1)
	bad.u8(strPos+4, 0xFF)
	bad.u8(strPos+5, 0)
	bad.root(tablePos)
	if _, err := Open(root, bad.buf, Limits{}); err == nil {
		t.Fatal("invalid UTF-8 must be rejected")
	}
}

// Table vectors validate each entry relative to that entry's own position.
func TestVectorOfTables(t *testing.T) {
	item, _ := NewTable("Item", Field{Name: "n", Kind: KindI32, Slot: 0})
	root, err := NewTable("Batch", Field{Name: "items", Kind: KindVectorTable, Slot: 0, RefTable: item})
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(160)
	const rvt, rtab, vecPos, t0, t1, ivt uint32 = 8, 16, 32, 64, 88, 112
	m.vtable(rvt, 8, 4)
	m.table(rtab, rvt)
	m.ref(rtab+4, vecPos)
	m.u32(vecPos, 2)
	m.ref(vecPos+4, t0)
	m.ref(vecPos+8, t1)
	m.vtable(ivt, 8, 4)
	m.table(t0, ivt)
	m.table(t1, ivt)
	m.i32(t0+4, 100)
	m.i32(t1+4, 200)
	m.root(rtab)

	h, err := Open(root, m.buf, Limits{MaxTables: 3, MaxVectorElements: 2})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	vec, err := h.Get(Step{Field: "items"})
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := vec.VectorLen(); n != 2 {
		t.Fatalf("len=%d", n)
	}
	first, err := vec.Element(0)
	if err != nil {
		t.Fatal(err)
	}
	n0, err := first.Get(Step{Field: "n"})
	if err != nil || mustI32(t, n0) != 100 {
		t.Fatalf("n0=%v err=%v", n0, err)
	}
	second, err := h.Get(Step{Field: "items"}, Step{Index: 1}, Step{Field: "n"})
	if err != nil || mustI32(t, second) != 200 {
		t.Fatalf("n1=%v err=%v", second, err)
	}
	if _, err := Open(root, m.buf, Limits{MaxTables: 2}); err == nil {
		t.Fatal("distinct table limit must count root plus two items")
	}
}

// Returned scalar vector slices are copies and cannot mutate the buffer.
func TestVectorCopiesAndRanges(t *testing.T) {
	root, err := NewTable("Msg",
		Field{Name: "i64s", Kind: KindVectorI64, Slot: 0},
		Field{Name: "bytes", Kind: KindVectorU8, Slot: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(160)
	const vtPos, tablePos, lvec, bvec uint32 = 8, 20, 36, 88
	m.vtable(vtPos, 12, 4, 8)
	m.table(tablePos, vtPos)
	m.ref(tablePos+4, lvec)
	m.ref(tablePos+8, bvec)
	m.u32(lvec, 2)
	m.i64(lvec+4, 1)
	m.i64(lvec+12, 2)
	m.u32(bvec, 3)
	m.u8(bvec+4, 9)
	m.u8(bvec+5, 8)
	m.u8(bvec+6, 7)
	m.root(tablePos)

	h, err := Open(root, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	lo, err := h.Get(Step{Field: "i64s"})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := lo.I64Elements()
	if !ok || len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("i64 elements=%v ok=%v", got, ok)
	}
	if lo.RefRange != (ByteRange{Start: uint64(lvec), End: uint64(lvec + 20)}) {
		t.Fatalf("i64 vector range=%+v", lo.RefRange)
	}
	bo, err := h.Get(Step{Field: "bytes"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := bo.U8Elements()
	raw[0] = 0
	if m.buf[bvec+4] != 9 {
		t.Fatal("U8Elements must return a copy, not the borrowed buffer")
	}
}

// Recursive self-referencing tables are reachable and terminate.
func TestRecursiveCycle(t *testing.T) {
	node, err := NewTable("Node", Field{Name: "id", Kind: KindI32, Slot: 0})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.Add(Field{Name: "next", Kind: KindTable, Slot: 1, RefTable: node}); err != nil {
		t.Fatal(err)
	}
	m := newMem(96)
	const vtPos, aPos, bPos uint32 = 8, 20, 44
	m.vtable(vtPos, 12, 4, 8)
	m.table(aPos, vtPos)
	m.table(bPos, vtPos)
	m.i32(aPos+4, 1)
	m.i32(bPos+4, 2)
	m.ref(aPos+8, bPos)
	m.ref(bPos+8, aPos)
	m.root(aPos)

	h, err := Open(node, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	v, err := h.Get(Step{Field: "next"}, Step{Field: "next"}, Step{Field: "id"})
	if err != nil || mustI32(t, v) != 1 {
		t.Fatalf("cycle read=%v err=%v", v, err)
	}
	if len(h.tables) != 2 {
		t.Fatalf("distinct tables=%d, want 2", len(h.tables))
	}
}

func TestMalformedRootsAndVTableRanges(t *testing.T) {
	root, _ := NewTable("R", Field{Name: "id", Kind: KindI32, Slot: 0})
	if _, err := Open(root, []byte{1, 2, 3}, Limits{}); err == nil {
		t.Fatal("short buffer rejected")
	}
	m := newMem(64)
	m.u32(0, 0)
	if _, err := Open(root, m.buf, Limits{}); err == nil {
		t.Fatal("zero root offset rejected")
	}
	m2 := newMem(64)
	const vtPos, tablePos uint32 = 8, 20
	m2.u32(0, tablePos-4)
	m2.u16(vtPos, 3) // odd vtable length
	m2.u16(vtPos+2, 8)
	m2.table(tablePos, vtPos)
	if _, err := Open(root, m2.buf, Limits{}); err == nil {
		t.Fatal("odd vtable length rejected")
	}
}
