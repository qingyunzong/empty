package dataeng

import (
	"errors"
	"testing"
)

func TestAccessorsAndReadErrors(t *testing.T) {
	item, _ := NewTable("Item", Field{Name: "n", Kind: KindI32, Slot: 0})
	root, err := NewTable("Root",
		Field{Name: "u", Kind: KindU8, Slot: 0, Default: 3},
		Field{Name: "i32", Kind: KindI32, Slot: 1},
		Field{Name: "i64", Kind: KindI64, Slot: 2},
		Field{Name: "text", Kind: KindString, Slot: 3},
		Field{Name: "child", Kind: KindTable, Slot: 4, RefTable: item},
		Field{Name: "i32s", Kind: KindVectorI32, Slot: 5},
		Field{Name: "items", Kind: KindVectorTable, Slot: 6, RefTable: item},
	)
	if err != nil {
		t.Fatal(err)
	}

	m := newMem(256)
	const (
		rtab, rvt uint32 = 24, 68 // root object [24,64), vtable [68,86)
		ctab, cvt uint32 = 96, 120
		str       uint32 = 136
		vec       uint32 = 156
		tvec      uint32 = 180
	)
	// Slot layout (schema order): u@4, i32@8, i64@16(8-aligned), text@24,
	// child@28, i32s@32, items@36. Object spans 40 bytes.
	m.vtable(rvt, 40, 4, 8, 16, 24, 28, 32, 36) // 7 slots
	m.table(rtab, rvt)
	m.u8(rtab+4, 250)
	m.i32(rtab+8, -5)
	m.i64(rtab+16, 1<<40) // slot 2, i64, 8-aligned
	m.ref(rtab+24, str)   // slot 3, text (i64 spans 16..24)
	m.ref(rtab+28, ctab)  // slot 4, child
	m.ref(rtab+32, vec)   // slot 5, i32s
	m.ref(rtab+36, tvec)  // slot 6, items
	m.stringAt(str, "ok")
	m.u32(vec, 2)
	m.i32(vec+4, 7)
	m.i32(vec+8, 8)
	m.u32(tvec, 1)
	m.ref(tvec+4, ctab)
	m.vtable(cvt, 8, 4)
	m.table(ctab, cvt)
	m.i32(ctab+4, 77)
	m.root(rtab)

	h, err := Open(root, m.buf, Limits{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if u, _ := h.Get(Step{Field: "u"}); u == nil {
		t.Fatal("missing u")
	} else if got, ok := u.U8(); !ok || got != 250 {
		t.Fatalf("u8=%d ok=%v", got, ok)
	}
	if v, _ := h.Get(Step{Field: "i32"}); true {
		if got, ok := v.I32(); !ok || got != -5 {
			t.Fatalf("i32=%d", got)
		}
		if _, ok := v.U8(); ok {
			t.Fatal("U8 must fail on i32 value")
		}
	}
	if v, _ := h.Get(Step{Field: "i64"}); true {
		if got, ok := v.I64(); !ok || got != 1<<40 {
			t.Fatalf("i64=%d", got)
		}
	}
	text, _ := h.Get(Step{Field: "text"})
	if got, ok := text.StringValue(); !ok || got != "ok" {
		t.Fatalf("string=%q", got)
	}
	if _, ok := text.I32(); ok {
		t.Fatal("I32 must fail on string")
	}
	child, _ := h.Get(Step{Field: "child"})
	pos, typ, ok := child.Table()
	if !ok || pos != uint64(ctab) || typ != item {
		t.Fatalf("table accessor pos=%d typ=%v ok=%v", pos, typ, ok)
	}
	i32s, _ := h.Get(Step{Field: "i32s"})
	if n, ok := i32s.VectorLen(); !ok || n != 2 {
		t.Fatalf("vector len=%d ok=%v", n, ok)
	}
	if vals, ok := i32s.I32Elements(); !ok || vals[0] != 7 || vals[1] != 8 {
		t.Fatalf("i32 elements=%v ok=%v", vals, ok)
	}
	if _, ok := i32s.U8Elements(); ok {
		t.Fatal("U8Elements must fail on i32 vector")
	}
	items, _ := h.Get(Step{Field: "items"})
	if _, err := items.Element(1); err == nil {
		t.Fatal("out-of-range vector index must fail")
	}
	missing, _ := h.Get(Step{Field: "u"})
	_ = missing

	// Wrong path shapes.
	if _, err := h.Get(Step{Field: "nope"}); err == nil {
		t.Fatal("unknown field must fail")
	}
	if _, err := h.Get(Step{Index: 1}); err == nil {
		t.Fatal("index step on table must fail")
	}
	if _, err := text.Get(Step{Field: "x"}); err == nil {
		t.Fatal("field step on scalar must fail")
	}
	nullRef, err := NewTable("N", Field{Name: "missing", Kind: KindString, Slot: 0})
	if err != nil {
		t.Fatal(err)
	}
	nm := newMem(48)
	const nvt, ntab uint32 = 8, 20
	nm.vtable(nvt, 8, 0)
	nm.table(ntab, nvt)
	nm.root(ntab)
	nh, err := Open(nullRef, nm.buf, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	nv, err := nh.Get(Step{Field: "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := nv.StringValue(); ok {
		t.Fatal("null string has no value")
	}
	if _, _, ok := nv.Table(); ok {
		t.Fatal("null string is not a table")
	}
	if _, err := nv.Get(Step{Field: "x"}); err == nil {
		t.Fatal("reading through null table must fail")
	}
}

func TestSchemaConstructionErrors(t *testing.T) {
	if _, err := NewTable(""); err == nil {
		t.Fatal("empty table name rejected")
	}
	if _, err := NewTable("T", Field{Name: "", Kind: KindI32}); err == nil {
		t.Fatal("empty field name rejected")
	}
	if _, err := NewTable("T",
		Field{Name: "a", Kind: KindI32, Slot: 0},
		Field{Name: "b", Kind: KindI32, Slot: 0},
	); err == nil {
		t.Fatal("duplicate slot rejected")
	}
	if _, err := NewTable("T",
		Field{Name: "a", Kind: KindI32},
		Field{Name: "a", Kind: KindU8},
	); err == nil {
		t.Fatal("duplicate name rejected")
	}
	if _, err := NewTable("T", Field{Name: "a", Kind: KindU8, Default: 256}); err == nil {
		t.Fatal("u8 default range rejected")
	}
	if _, err := NewTable("T", Field{Name: "a", Kind: KindI32, Default: 1 << 40}); err == nil {
		t.Fatal("i32 default range rejected")
	}
	tab, _ := NewTable("T", Field{Name: "a", Kind: KindI32})
	if _, err := NewTable("U", Field{Name: "f", Kind: Kind(99)}); err == nil {
		t.Fatal("unknown kind rejected")
	}
	if _, err := Open(tab, []byte{0, 0, 0, 0}, Limits{}); err == nil {
		t.Fatal("zero root offset rejected")
	}
	var e *Error
	if _, err := Open(nil, []byte{0, 0, 0, 0}, Limits{}); !errors.As(err, &e) {
		t.Fatalf("want typed Error, got %v", err)
	}
}

func TestErrorStringShape(t *testing.T) {
	withPath := &Error{Phase: "open", Path: "a.b", Reason: "bad"}
	if withPath.Error() == "" {
		t.Fatal("error message empty")
	}
	noPath := &Error{Phase: "read", Reason: "bad"}
	if noPath.Error() == "" {
		t.Fatal("error message empty")
	}
}
