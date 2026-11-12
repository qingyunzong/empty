package dataeng

import (
	"errors"
	"testing"
)

func currentSchema(t *testing.T) (*Table, *Table) {
	t.Helper()
	node, err := NewTable("Node",
		Field{Name: "id", Kind: KindI32, Slot: 0, Default: -1},
		Field{Name: "name", Kind: KindString, Slot: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	child, err := NewTable("Child",
		Field{Name: "weight", Kind: KindU8, Slot: 0, Default: 7},
		Field{Name: "code", Kind: KindI64, Slot: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := node.Add(Field{Name: "next", Kind: KindTable, Slot: 2, RefTable: node}); err != nil {
		t.Fatal(err)
	}
	if err := node.Add(Field{Name: "child", Kind: KindTable, Slot: 3, RefTable: child}); err != nil {
		t.Fatal(err)
	}
	return node, child
}

// Old producers emitted a short vtable: current schema slots beyond the old
// vtable must be treated as missing instead of rejecting the message.
func TestOldShortVTable(t *testing.T) {
	node, _ := currentSchema(t)

	m := newMem(128)
	const vtPos, tablePos, strPos uint32 = 8, 24, 40
	// Old vtable only carries slots 0 and 1; slots 2 and 3 do not exist.
	m.vtable(vtPos, 12, 4, 8)
	m.table(tablePos, vtPos)
	m.i32(tablePos+4, 42)
	m.ref(tablePos+8, strPos)
	m.stringAt(strPos, "dev-42")
	m.root(tablePos)

	h, err := Open(node, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	id, err := h.Get(Step{Field: "id"})
	if err != nil || mustI32(t, id) != 42 {
		t.Fatalf("id = %v, err=%v, want 42", id, err)
	}
	if id.Defaulted || id.Range != (ByteRange{Start: 28, End: 32}) {
		t.Fatalf("unexpected present metadata: defaulted=%v range=%+v", id.Defaulted, id.Range)
	}
	next, err := h.Get(Step{Field: "next"})
	if err != nil {
		t.Fatal(err)
	}
	if !next.IsNull || next.Present {
		t.Fatalf("missing table ref should be null: %+v", next)
	}
	child, err := h.Get(Step{Field: "child"})
	if err != nil {
		t.Fatal(err)
	}
	if !child.IsNull {
		t.Fatalf("slot outside old vtable must be null")
	}
}

// A vtable may sit after its object; the signed distance d is then negative.
func TestVTableAfterObject(t *testing.T) {
	child, _ := NewTable("Child",
		Field{Name: "weight", Kind: KindU8, Slot: 0, Default: 7},
		Field{Name: "code", Kind: KindI64, Slot: 1},
	)
	m := newMem(64)
	const tablePos, vtPos uint32 = 8, 32
	m.vtable(vtPos, 16, 4, 8)
	m.table(tablePos, vtPos)
	m.u8(tablePos+4, 9)
	m.i64(tablePos+8, -123456789012)
	m.root(tablePos)

	h, err := Open(child, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	weight, err := h.Get(Step{Field: "weight"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := weight.U8(); got != 9 || weight.Defaulted {
		t.Fatalf("weight=%d defaulted=%v", got, weight.Defaulted)
	}
	if d := int32(tablePos) - int32(vtPos); d >= 0 {
		t.Fatalf("test setup expected negative d, got %d", d)
	}
}

// Two table objects may legally share one vtable; sharing is not corruption.
func TestSharedVTable(t *testing.T) {
	node, _ := currentSchema(t)
	m := newMem(160)
	const vtPos, aPos, bPos, strA, strB uint32 = 8, 24, 48, 72, 96
	m.vtable(vtPos, 16, 4, 8, 12)
	m.table(aPos, vtPos)
	m.table(bPos, vtPos)
	m.i32(aPos+4, 1)
	m.i32(bPos+4, 2)
	m.ref(aPos+8, strA)
	m.ref(bPos+8, strB)
	m.stringAt(strA, "a")
	m.stringAt(strB, "b")
	// root references b through slot 2 of a.
	m.ref(aPos+12, bPos)
	// The shared vtable activates slot 2 for both objects; make b's graph a
	// cycle back to a, which also proves recursive tables terminate.
	m.ref(bPos+12, aPos)
	m.root(aPos)

	h, err := Open(node, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	rootID, _ := h.Get(Step{Field: "id"})
	if mustI32(t, rootID) != 1 {
		t.Fatalf("root id=%d", mustI32(t, rootID))
	}
	nextID, err := h.Get(Step{Field: "next"}, Step{Field: "id"})
	if err != nil {
		t.Fatal(err)
	}
	if mustI32(t, nextID) != 2 {
		t.Fatalf("next id=%d", mustI32(t, nextID))
	}
	if len(h.vtables) != 1 || len(h.tables) != 2 {
		t.Fatalf("want one shared vtable and two tables, got vt=%d tables=%d", len(h.vtables), len(h.tables))
	}
}

// Two fields can reference the same string; distinct string bytes are charged
// once.
func TestSharedString(t *testing.T) {
	root, err := NewTable("Msg",
		Field{Name: "first", Kind: KindString, Slot: 0},
		Field{Name: "second", Kind: KindString, Slot: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(96)
	const vtPos, tablePos, strPos uint32 = 8, 20, 32
	m.vtable(vtPos, 12, 4, 8)
	m.table(tablePos, vtPos)
	m.ref(tablePos+4, strPos)
	m.ref(tablePos+8, strPos)
	m.stringAt(strPos, "shared-ø")
	m.root(tablePos)

	h, err := Open(root, m.buf, Limits{MaxStringBytes: len("shared-ø")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first, err := h.Get(Step{Field: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.Get(Step{Field: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if s1, _ := first.StringValue(); s1 != "shared-ø" {
		t.Fatalf("first=%q", s1)
	}
	if s2, _ := second.StringValue(); s2 != "shared-ø" {
		t.Fatalf("second=%q", s2)
	}
	if len(h.strings) != 1 {
		t.Fatalf("shared string cached once, got %d", len(h.strings))
	}
	if _, err := Open(root, m.buf, Limits{MaxStringBytes: len("shared-ø") - 1}); err == nil {
		t.Fatal("expected string byte limit rejection")
	}
}

// Missing scalars use schema defaults; explicit zero is reported as present.
// Missing references are null; a stored zero offset is rejected.
func TestMissingDefaultAndZeroRef(t *testing.T) {
	child, err := NewTable("Child",
		Field{Name: "weight", Kind: KindU8, Slot: 0, Default: 7},
		Field{Name: "code", Kind: KindI64, Slot: 1, Default: 99},
		Field{Name: "label", Kind: KindString, Slot: 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(96)
	const vtPos, tablePos uint32 = 8, 24
	// Slot 0 absent (offset 0), slot 1 present with value zero at offset 8
	// (i64 needs 8-alignment), slot 2 absent.
	m.vtable(vtPos, 16, 0, 8)
	m.table(tablePos, vtPos)
	m.i64(tablePos+8, 0)
	m.root(tablePos)

	h, err := Open(child, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	weight, err := h.Get(Step{Field: "weight"})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := weight.U8(); !ok || got != 7 || !weight.Defaulted || weight.Present {
		t.Fatalf("missing u8: got=%d ok=%v defaulted=%v present=%v", got, ok, weight.Defaulted, weight.Present)
	}
	code, err := h.Get(Step{Field: "code"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := code.I64(); got != 0 || code.Defaulted || !code.Present {
		t.Fatalf("explicit zero: got=%d defaulted=%v present=%v", got, code.Defaulted, code.Present)
	}
	if code.Range != (ByteRange{Start: uint64(tablePos + 8), End: uint64(tablePos + 16)}) {
		t.Fatalf("explicit value range=%+v", code.Range)
	}
	label, err := h.Get(Step{Field: "label"})
	if err != nil {
		t.Fatal(err)
	}
	if !label.IsNull || label.Defaulted {
		t.Fatalf("missing string must be null, got %+v", label)
	}

	// Present reference field storing zero must fail validation.
	bad := newMem(48)
	const bvt, btab uint32 = 8, 20
	bad.vtable(bvt, 12, 0, 0, 4)
	bad.table(btab, bvt)
	bad.u32(btab+4, 0)
	bad.root(btab)
	if _, err := Open(child, bad.buf, Limits{}); err == nil {
		t.Fatal("stored zero reference offset must be rejected")
	}
}

// Declared vector limits are enforced before the oversized vector is admitted.
func TestVectorLimits(t *testing.T) {
	root, err := NewTable("Batch",
		Field{Name: "samples", Kind: KindVectorI32, Slot: 0},
		Field{Name: "raw", Kind: KindVectorU8, Slot: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := newMem(128)
	const vtPos, tablePos, vecPos uint32 = 8, 20, 32
	m.vtable(vtPos, 12, 4)
	m.table(tablePos, vtPos)
	m.ref(tablePos+4, vecPos)
	m.u32(vecPos, 4)
	m.i32(vecPos+4, 10)
	m.i32(vecPos+8, 20)
	m.i32(vecPos+12, 30)
	m.i32(vecPos+16, 40)
	m.root(tablePos)

	if _, err := Open(root, m.buf, Limits{MaxVectorElements: 4}); err != nil {
		t.Fatalf("exact limit should pass: %v", err)
	}
	if _, err := Open(root, m.buf, Limits{MaxVectorElements: 3}); err == nil {
		t.Fatal("vector element limit must reject oversized vector")
	}

	// Claimed count larger than the buffer cannot be allocated/validated.
	claim := newMem(64)
	const cvt, ctab, cvec uint32 = 8, 20, 32
	claim.vtable(cvt, 12, 4)
	claim.table(ctab, cvt)
	claim.ref(ctab+4, cvec)
	claim.u32(cvec, 1_000_000)
	claim.root(ctab)
	var e *Error
	if _, err := Open(root, claim.buf, Limits{}); !errors.As(err, &e) || e.Phase != "open" {
		t.Fatalf("want open error for huge vector, got %v", err)
	}
}
