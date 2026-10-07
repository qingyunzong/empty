package layout

import (
	"errors"
	"math"
	"sort"
	"testing"
)

func TestBasicAlignmentAndTailPadding(t *testing.T) {
	typ := StructOf(
		F("a", IntOf(1)),
		F("b", IntOf(4)),
		F("c", IntOf(2)),
	)
	l, err := Compute(typ, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantOffsets := []uint64{0, 4, 8}
	for i, f := range l.Fields {
		if f.Offset != wantOffsets[i] {
			t.Errorf("field %s offset = %d, want %d", f.Name, f.Offset, wantOffsets[i])
		}
	}
	if l.Align != 4 {
		t.Errorf("align = %d, want 4", l.Align)
	}
	if l.Size != 12 { // last end 10 padded up to align 4
		t.Errorf("size = %d, want 12", l.Size)
	}
}

func TestNestedStruct(t *testing.T) {
	inner := StructOf(F("x", IntOf(8)), F("y", IntOf(1)))
	outer := StructOf(F("tag", IntOf(1)), F("inner", inner), F("tail", IntOf(2)))
	l, err := Compute(outer, nil)
	if err != nil {
		t.Fatal(err)
	}
	// inner: size 16 align 8 -> outer.tag at 0, inner at 8, tail at 24, size 32
	if got := l.Fields[1].Offset; got != 8 {
		t.Errorf("inner offset = %d, want 8", got)
	}
	if got := l.Fields[2].Offset; got != 24 {
		t.Errorf("tail offset = %d, want 24", got)
	}
	if l.Size != 32 || l.Align != 8 {
		t.Errorf("size/align = %d/%d, want 32/8", l.Size, l.Align)
	}
	// Nested field offsets are relative to the nested struct.
	if got := l.Fields[1].Layout.Fields[1].Offset; got != 8 {
		t.Errorf("inner.y offset = %d, want 8", got)
	}
}

func TestFixedArray(t *testing.T) {
	elem := StructOf(F("v", IntOf(4)), F("pad", IntOf(1)))
	typ := StructOf(F("head", IntOf(2)), F("arr", ArrayOf(elem, 3)))
	l, err := Compute(typ, nil)
	if err != nil {
		t.Fatal(err)
	}
	// elem: size 8 align 4; arr at offset 4, size 24; total 28 align 4
	if got := l.Fields[1].Offset; got != 4 {
		t.Errorf("arr offset = %d, want 4", got)
	}
	arr := l.Fields[1].Layout
	if arr.Size != 24 || arr.Align != 4 {
		t.Errorf("arr size/align = %d/%d, want 24/4", arr.Size, arr.Align)
	}
	if l.Size != 28 {
		t.Errorf("size = %d, want 28", l.Size)
	}
	leaves, err := l.Leaves(typ, nil, 0, "s")
	if err != nil {
		t.Fatal(err)
	}
	// arr[1].v must sit one stride (8) past arr[0].v.
	var v0, v1 uint64
	for _, r := range leaves {
		switch r.Path {
		case "s.arr[0].v":
			v0 = r.Offset
		case "s.arr[1].v":
			v1 = r.Offset
		}
	}
	if v1-v0 != 8 {
		t.Errorf("array stride = %d, want 8", v1-v0)
	}
}

func TestRecursiveValueTypeRejected(t *testing.T) {
	env := Env{
		"A": StructOf(F("b", RefOf("B"))),
		"B": StructOf(F("a", RefOf("A"))),
	}
	_, err := Compute(RefOf("A"), env)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("err = %v, want CycleError", err)
	}
	want := []string{"A", "B", "A"}
	if len(cyc.Chain) != len(want) {
		t.Fatalf("chain = %v, want %v", cyc.Chain, want)
	}
	for i := range want {
		if cyc.Chain[i] != want[i] {
			t.Fatalf("chain = %v, want %v", cyc.Chain, want)
		}
	}
}

func TestSelfRecursionRejected(t *testing.T) {
	env := Env{"Node": StructOf(F("next", RefOf("Node")))}
	_, err := Compute(RefOf("Node"), env)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("err = %v, want CycleError", err)
	}
	if got := cyc.Error(); got != "recursive value type: Node -> Node" {
		t.Errorf("message = %q", got)
	}
}

func TestOverflowPublishesNoLayout(t *testing.T) {
	typ := ArrayOf(IntOf(8), math.MaxUint64/4)
	l, err := Compute(typ, nil)
	var ovf *OverflowError
	if !errors.As(err, &ovf) {
		t.Fatalf("err = %v, want OverflowError", err)
	}
	if l != nil {
		t.Errorf("layout = %+v, want nil on overflow", l)
	}
	// Overflow deep inside a struct field must also fail the whole layout.
	nested := StructOf(F("ok", IntOf(1)), F("boom", typ))
	l, err = Compute(nested, nil)
	if !errors.As(err, &ovf) || l != nil {
		t.Errorf("nested overflow: layout=%v err=%v, want nil + OverflowError", l, err)
	}
}

func TestNonPowerOfTwoIntRejected(t *testing.T) {
	if _, err := Compute(IntOf(3), nil); err == nil {
		t.Fatal("want error for size 3")
	}
	if _, err := Compute(IntOf(0), nil); err == nil {
		t.Fatal("want error for size 0")
	}
}

// --- Low-size enumeration: verify no overlap and minimal offsets. ---

// checkMinimal verifies, recursively, that every field sits at the
// smallest aligned offset after the previous field, and that the
// struct size is the smallest multiple of its alignment covering the
// last field. It returns all absolute leaf ranges found.
func checkMinimal(t *testing.T, typ Type, env Env, l *Layout, base uint64, path string) []LeafRange {
	t.Helper()
	switch typ.Kind {
	case Int:
		if l.Size != typ.Size || l.Align != typ.Size {
			t.Fatalf("%s: int size/align = %d/%d, want %d/%d", path, l.Size, l.Align, typ.Size, typ.Size)
		}
		return []LeafRange{{Path: path, Offset: base, Size: l.Size}}
	case Ref:
		return checkMinimal(t, env[typ.Name], env, l, base, path)
	case Array:
		elem, err := Compute(*typ.Elem, env)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if l.Align != elem.Align {
			t.Fatalf("%s: array align = %d, want elem align %d", path, l.Align, elem.Align)
		}
		if l.Size != elem.Size*typ.Count {
			t.Fatalf("%s: array size = %d, want %d", path, l.Size, elem.Size*typ.Count)
		}
		var ranges []LeafRange
		for i := uint64(0); i < typ.Count; i++ {
			ranges = append(ranges, checkMinimal(t, *typ.Elem, env, elem, base+i*elem.Size, path)...)
		}
		return ranges
	case Struct:
		if len(l.Fields) != len(typ.Fields) {
			t.Fatalf("%s: got %d field layouts, want %d", path, len(l.Fields), len(typ.Fields))
		}
		offset := uint64(0)
		maxAlign := uint64(1)
		var ranges []LeafRange
		for i, f := range typ.Fields {
			fl := l.Fields[i]
			if fl.Offset%fl.Layout.Align != 0 {
				t.Fatalf("%s.%s: offset %d not aligned to %d", path, f.Name, fl.Offset, fl.Layout.Align)
			}
			if fl.Offset < offset {
				t.Fatalf("%s.%s: offset %d overlaps previous end %d", path, f.Name, fl.Offset, offset)
			}
			if want := alignUp(offset, fl.Layout.Align); fl.Offset != want {
				t.Fatalf("%s.%s: offset %d not minimal, want %d", path, f.Name, fl.Offset, want)
			}
			if fl.Layout.Align > maxAlign {
				maxAlign = fl.Layout.Align
			}
			offset = fl.Offset + fl.Layout.Size
			ranges = append(ranges, checkMinimal(t, f.Type, env, fl.Layout, base+fl.Offset, path+"."+f.Name)...)
		}
		if l.Align != maxAlign {
			t.Fatalf("%s: align = %d, want max field align %d", path, l.Align, maxAlign)
		}
		if want := alignUp(offset, maxAlign); l.Size != want {
			t.Fatalf("%s: size = %d, want minimal padded %d", path, l.Size, want)
		}
		return ranges
	default:
		t.Fatalf("%s: unexpected kind %d", path, typ.Kind)
		return nil
	}
}

func assertNoOverlap(t *testing.T, ranges []LeafRange) {
	t.Helper()
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Offset < ranges[j].Offset })
	for i := 1; i < len(ranges); i++ {
		prev, cur := ranges[i-1], ranges[i]
		if cur.Offset < prev.Offset+prev.Size {
			t.Fatalf("overlap: %s [%d,%d) vs %s [%d,%d)",
				prev.Path, prev.Offset, prev.Offset+prev.Size,
				cur.Path, cur.Offset, cur.Offset+cur.Size)
		}
	}
}

func TestEnumerateLowSizes(t *testing.T) {
	sizes := []uint64{1, 2, 4, 8}
	ints := make([]Type, len(sizes))
	for i, s := range sizes {
		ints[i] = IntOf(s)
	}

	var types []Type
	// Single ints and arrays of ints (counts 1..4).
	for _, it := range ints {
		types = append(types, it)
		for n := uint64(1); n <= 4; n++ {
			types = append(types, ArrayOf(it, n))
		}
	}
	// All 2-field structs of ints, in both size orders.
	for _, a := range ints {
		for _, b := range ints {
			types = append(types, StructOf(F("f0", a), F("f1", b)))
		}
	}
	// All 3-field structs of ints (64 combos).
	for _, a := range ints {
		for _, b := range ints {
			for _, c := range ints {
				types = append(types, StructOf(F("f0", a), F("f1", b), F("f2", c)))
			}
		}
	}
	// Nested structs and arrays of structs.
	inner := StructOf(F("x", IntOf(8)), F("y", IntOf(1)))
	for _, it := range ints {
		types = append(types, StructOf(F("head", it), F("in", inner), F("tail", it)))
		types = append(types, StructOf(F("head", it), F("arr", ArrayOf(inner, 3))))
	}

	for i, typ := range types {
		l, err := Compute(typ, nil)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		ranges := checkMinimal(t, typ, nil, l, 0, "root")
		assertNoOverlap(t, ranges)
		// Cross-check the independent Leaves flattening agrees.
		leaves, err := l.Leaves(typ, nil, 0, "root")
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if len(leaves) != len(ranges) {
			t.Fatalf("case %d: Leaves found %d ranges, want %d", i, len(leaves), len(ranges))
		}
		assertNoOverlap(t, leaves)
	}
}
