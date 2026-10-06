package layout

import (
	"errors"
	"fmt"
	"math"
	"testing"
)

func offsets(l Layout) map[string]int64 {
	m := make(map[string]int64, len(l.Fields))
	for _, f := range l.Fields {
		m[f.Name] = f.Offset
	}
	return m
}

func TestBasicAlignmentAndTailPadding(t *testing.T) {
	typ := Struct("S",
		F("a", Int(8)),
		F("b", Int(32)),
		F("c", Int(8)),
	)
	l, err := Compute(typ)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	got := offsets(l)
	want := map[string]int64{"a": 0, "b": 4, "c": 8}
	for name, off := range want {
		if got[name] != off {
			t.Errorf("field %s offset = %d, want %d", name, got[name], off)
		}
	}
	if l.Align != 4 {
		t.Errorf("align = %d, want 4", l.Align)
	}
	if l.Size != 12 {
		t.Errorf("size = %d, want 12 (tail padded to align 4)", l.Size)
	}
	if err := Validate(l); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestNestedStruct(t *testing.T) {
	inner := Struct("Inner",
		F("x", Int(64)),
		F("y", Int(8)),
	)
	outer := Struct("Outer",
		F("tag", Int(16)),
		F("in", inner),
		F("tail", Int(8)),
	)
	l, err := Compute(outer)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	got := offsets(l)
	// Inner has size 16 (8 + 1 padded to 8), align 8.
	want := map[string]int64{"tag": 0, "in": 8, "tail": 24}
	for name, off := range want {
		if got[name] != off {
			t.Errorf("field %s offset = %d, want %d", name, got[name], off)
		}
	}
	if l.Size != 32 || l.Align != 8 {
		t.Errorf("size/align = %d/%d, want 32/8", l.Size, l.Align)
	}
	if err := Validate(l); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestArrayOfStructsUsesPaddedSize(t *testing.T) {
	elem := Struct("E",
		F("v", Int(32)),
		F("b", Int(8)),
	) // size 8 after tail padding, align 4
	typ := Struct("S",
		F("arr", Array(elem, 3)),
		F("n", Int(16)),
	)
	l, err := Compute(typ)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	got := offsets(l)
	if got["arr"] != 0 || got["n"] != 24 {
		t.Errorf("offsets = %v, want arr=0 n=24 (3 * padded 8)", got)
	}
	if l.Size != 28 || l.Align != 4 {
		t.Errorf("size/align = %d/%d, want 28/4", l.Size, l.Align)
	}
	if err := Validate(l); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestZeroLengthArray(t *testing.T) {
	typ := Struct("S",
		F("a", Int(8)),
		F("z", Array(Int(32), 0)),
		F("b", Int(8)),
	)
	l, err := Compute(typ)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	got := offsets(l)
	if got["z"] != 4 || got["b"] != 4 {
		t.Errorf("offsets = %v, want z=4 (aligned, zero size) b=4", got)
	}
	if err := Validate(l); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestRecursionChain(t *testing.T) {
	a := &Type{Kind: StructKind, Name: "A"}
	b := &Type{Kind: StructKind, Name: "B"}
	a.Fields = []Field{F("b", b)}
	b.Fields = []Field{F("a", a)}

	_, err := Compute(a)
	var rec *RecursionError
	if !errors.As(err, &rec) {
		t.Fatalf("err = %v, want RecursionError", err)
	}
	want := []string{"A", "B", "A"}
	if fmt.Sprint(rec.Chain) != fmt.Sprint(want) {
		t.Errorf("chain = %v, want %v", rec.Chain, want)
	}
}

func TestSelfRecursion(t *testing.T) {
	s := &Type{Kind: StructKind, Name: "Node"}
	s.Fields = []Field{F("next", s)}

	_, err := Compute(s)
	var rec *RecursionError
	if !errors.As(err, &rec) {
		t.Fatalf("err = %v, want RecursionError", err)
	}
	if fmt.Sprint(rec.Chain) != "[Node Node]" {
		t.Errorf("chain = %v, want [Node Node]", rec.Chain)
	}
}

func TestRecursionThroughArray(t *testing.T) {
	s := &Type{Kind: StructKind, Name: "Tree"}
	s.Fields = []Field{F("kids", Array(s, 4))}

	if _, err := Compute(s); err == nil {
		t.Fatal("expected recursion error through array element")
	} else {
		var rec *RecursionError
		if !errors.As(err, &rec) {
			t.Fatalf("err = %v, want RecursionError", err)
		}
	}
}

func TestOverflowNotPublished(t *testing.T) {
	c := NewComputer()
	big := Struct("Big",
		F("huge", Array(Int(64), math.MaxInt64/4)),
		F("x", Int(64)),
	)
	if _, err := c.Layout(big); !errors.Is(err, ErrOverflow) {
		t.Fatalf("err = %v, want ErrOverflow", err)
	}
	// The failed layout must not be cached: a second attempt still errors
	// rather than returning a stale partial result.
	if _, err := c.Layout(big); !errors.Is(err, ErrOverflow) {
		t.Fatalf("second call err = %v, want ErrOverflow", err)
	}
	if _, ok := c.cache[big]; ok {
		t.Fatal("overflowed layout was published to the cache")
	}
	// And the computer keeps working for well-formed types.
	ok := Struct("OK", F("a", Int(8)))
	if _, err := c.Layout(ok); err != nil {
		t.Fatalf("layout after overflow: %v", err)
	}
}

func TestOverflowAtStructEnd(t *testing.T) {
	typ := Struct("S",
		F("huge", Array(Int(8), math.MaxInt64-3)),
		F("tail", Int(64)),
	)
	if _, err := Compute(typ); !errors.Is(err, ErrOverflow) {
		t.Fatalf("err = %v, want ErrOverflow", err)
	}
}

func TestValidateRejectsBadLayouts(t *testing.T) {
	good := Layout{
		Size:  8,
		Align: 4,
		Fields: []FieldLayout{
			{Name: "a", Offset: 0, Size: 1, Align: 1},
			{Name: "b", Offset: 4, Size: 4, Align: 4},
		},
	}
	if err := Validate(good); err != nil {
		t.Fatalf("Validate(good): %v", err)
	}

	overlap := good
	overlap.Fields = append([]FieldLayout(nil), good.Fields...)
	overlap.Fields[1] = FieldLayout{Name: "b", Offset: 0, Size: 4, Align: 4}
	if err := Validate(overlap); err == nil {
		t.Error("Validate accepted overlapping fields")
	}

	padded := good
	padded.Fields = append([]FieldLayout(nil), good.Fields...)
	padded.Fields[1] = FieldLayout{Name: "b", Offset: 8, Size: 4, Align: 4}
	padded.Size = 12
	if err := Validate(padded); err == nil {
		t.Error("Validate accepted non-minimal offset")
	}

	badTail := good
	badTail.Size = 16
	if err := Validate(badTail); err == nil {
		t.Error("Validate accepted non-minimal tail size")
	}
}

// TestEnumerateSmallStructs enumerates every struct of 1..4 fields whose
// members are 1, 2, 4 or 8 byte integers, and checks that each computed
// layout is valid: no field overlaps another and every offset is minimal.
func TestEnumerateSmallStructs(t *testing.T) {
	sizes := []int64{8, 16, 32, 64}
	checked := 0
	for n := 1; n <= 4; n++ {
		total := 1
		for i := 0; i < n; i++ {
			total *= len(sizes)
		}
		for combo := 0; combo < total; combo++ {
			fields := make([]Field, n)
			x := combo
			for i := 0; i < n; i++ {
				bits := sizes[x%len(sizes)]
				x /= len(sizes)
				fields[i] = F(fmt.Sprintf("f%d", i), Int(bits))
			}
			l, err := Compute(Struct("E", fields...))
			if err != nil {
				t.Fatalf("combo %d: Compute: %v", combo, err)
			}
			if err := Validate(l); err != nil {
				t.Fatalf("combo %d fields %v: %v", combo, fields, err)
			}
			assertNoOverlap(t, l)
			assertMinimal(t, l)
			checked++
		}
	}
	t.Logf("validated %d struct layouts", checked)
}

// assertNoOverlap independently checks that field intervals are disjoint.
func assertNoOverlap(t *testing.T, l Layout) {
	t.Helper()
	for i := 0; i < len(l.Fields); i++ {
		for j := i + 1; j < len(l.Fields); j++ {
			a, b := l.Fields[i], l.Fields[j]
			if a.Offset < b.Offset+b.Size && b.Offset < a.Offset+a.Size {
				t.Fatalf("fields %s [%d,%d) and %s [%d,%d) overlap",
					a.Name, a.Offset, a.Offset+a.Size,
					b.Name, b.Offset, b.Offset+b.Size)
			}
		}
	}
}

// assertMinimal recomputes the tightest possible layout from scratch and
// requires exact agreement with the computed one.
func assertMinimal(t *testing.T, l Layout) {
	t.Helper()
	end := int64(0)
	maxAlign := int64(1)
	for _, f := range l.Fields {
		if rem := end % f.Align; rem != 0 {
			end += f.Align - rem
		}
		if f.Offset != end {
			t.Fatalf("field %s offset %d, minimal is %d", f.Name, f.Offset, end)
		}
		end += f.Size
		if f.Align > maxAlign {
			maxAlign = f.Align
		}
	}
	if rem := end % maxAlign; rem != 0 {
		end += maxAlign - rem
	}
	if l.Size != end || l.Align != maxAlign {
		t.Fatalf("size/align = %d/%d, minimal is %d/%d", l.Size, l.Align, end, maxAlign)
	}
}
