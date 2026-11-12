package virtualarray

import (
	"context"
	"math/big"
	"testing"
)

func TestNewRejectsBadShapesAndRanks(t *testing.T) {
	cases := []struct {
		name  string
		shape []*big.Int
	}{
		{"empty", nil},
		{"rank zero", []*big.Int{}},
		{"rank nine", shape(1, 1, 1, 1, 1, 1, 1, 1, 1)},
		{"negative", []*big.Int{bi(-1)}},
		{"nil dimension", []*big.Int{nil}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.shape, 0, nil, nil); err != ErrInvalidShape {
				t.Fatalf("err = %v, want ErrInvalidShape", err)
			}
		})
	}
}

func TestNewRejectsBadSelections(t *testing.T) {
	good := func() Mapping {
		return Mapping{
			SourceName:  "s",
			SourceShape: shape(5),
			VirtualSel:  sel(axis(0, 1, 1, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1)),
		}
	}

	t.Run("rank mismatch", func(t *testing.T) {
		m := good()
		m.VirtualSel = sel(axis(0, 1, 1, 1), axis(0, 1, 1, 1))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v, want ErrInvalidSelection", err)
		}
	})

	t.Run("zero stride", func(t *testing.T) {
		m := good()
		m.VirtualSel = sel(axis(0, 0, 1, 1))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("zero block", func(t *testing.T) {
		m := good()
		m.SourceSel = sel(axis(0, 1, 1, 0))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("stride below block", func(t *testing.T) {
		m := good()
		m.VirtualSel = sel(axis(0, 1, 1, 2))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("coordinate out of bounds", func(t *testing.T) {
		m := good()
		// last coordinate = 4 + 1 = 5 >= shape 5
		m.VirtualSel = sel(axis(4, 1, 2, 1))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("start beyond dimension", func(t *testing.T) {
		m := good()
		m.VirtualSel = Selection{Axes: []AxisSel{
			{Start: bi(6), Stride: bi(1), Count: bi(0), Block: bi(1)},
		}}
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("nil parameter", func(t *testing.T) {
		m := good()
		m.VirtualSel = Selection{Axes: []AxisSel{{Start: nil, Stride: bi(1), Count: bi(1), Block: bi(1)}}}
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidSelection {
			t.Fatalf("err = %v", err)
		}
	})
}

// TestEmptySelectionValidation ensures zero-count selections are still fully
// validated but are not required to fit a fabricated last coordinate.
func TestEmptySelectionValidation(t *testing.T) {
	emptyAxis := AxisSel{Start: bi(5), Stride: bi(2), Count: bi(0), Block: bi(2)}
	m := Mapping{
		SourceName:  "s",
		SourceShape: shape(5),
		VirtualSel:  Selection{Axes: []AxisSel{emptyAxis}},
		SourceSel:   Selection{Axes: []AxisSel{emptyAxis}},
	}
	// start == dimension length is allowed for an empty selection.
	va, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("empty selection at boundary should be valid: %v", err)
	}

	// It selects nothing, so every read is fill with no callback.
	h := newHost()
	got, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect([]int64{0}, []int64{5}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	for i, p := range got.Points {
		if !p.Filled || p.FillReason != NoMapping || h.readCalls != 0 {
			t.Fatalf("empty mapping point %d wrong: %+v", i, p)
		}
	}

	// Empty source selection but non-empty virtual selection must fail.
	bad := Mapping{
		SourceName:  "s",
		SourceShape: shape(5),
		VirtualSel:  sel(axis(0, 1, 1, 1)),
		SourceSel:   Selection{Axes: []AxisSel{emptyAxis}},
	}
	if _, err := New(shape(5), 0, []Mapping{bad}, ordersFor(COrder, "s")); err != ErrInvalidMapping {
		t.Fatalf("mismatched point counts err = %v, want ErrInvalidMapping", err)
	}
}

func TestNewRejectsMappingConsistency(t *testing.T) {
	base := func(source string, srcShape []*big.Int) Mapping {
		return Mapping{
			SourceName:  source,
			SourceShape: srcShape,
			VirtualSel:  sel(axis(0, 1, 1, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1)),
		}
	}

	t.Run("unknown source order", func(t *testing.T) {
		m := base("s", shape(5))
		if _, err := New(shape(5), 0, []Mapping{m}, map[string]Order{}); err != ErrInvalidMapping {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("same source different shape", func(t *testing.T) {
		m1 := base("s", shape(5))
		m2 := base("s", shape(6))
		if _, err := New(shape(5), 0, []Mapping{m1, m2}, ordersFor(COrder, "s")); err != ErrInvalidMapping {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("same source different order", func(t *testing.T) {
		m1 := base("s", shape(5))
		m2 := base("s", shape(5))
		m1.Order = COrder
		m2.Order = FOrder
		if _, err := New(shape(5), 0, []Mapping{m1, m2},
			map[string]Order{}); err != ErrInvalidMapping {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("point count mismatch", func(t *testing.T) {
		m := base("s", shape(5))
		m.SourceSel = sel(axis(0, 1, 2, 1))
		if _, err := New(shape(5), 0, []Mapping{m}, ordersFor(COrder, "s")); err != ErrInvalidMapping {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestReadRectValidation(t *testing.T) {
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(3),
		VirtualSel:  sel(axis(0, 1, 3, 1)),
		SourceSel:   sel(axis(0, 1, 3, 1)),
	}}
	va, err := New(shape(3), 0, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h := newHost()

	if _, err := va.ReadRect(context.Background(), Snapshot{},
		rect([]int64{0, 0}, []int64{1, 1}), nil, h.read); err != ErrInvalidRect {
		t.Fatalf("rank mismatch err = %v", err)
	}
	if _, err := va.ReadRect(context.Background(), Snapshot{},
		rect([]int64{2}, []int64{1}), nil, h.read); err != ErrInvalidRect {
		t.Fatalf("lo>hi err = %v", err)
	}
	if _, err := va.ReadRect(context.Background(), Snapshot{},
		rect([]int64{0}, []int64{4}), nil, h.read); err != ErrInvalidRect {
		t.Fatalf("hi>shape err = %v", err)
	}
	if _, err := va.ReadRect(context.Background(), Snapshot{},
		Rect{Lo: []*big.Int{nil}, Hi: []*big.Int{bi(1)}}, nil, h.read); err != ErrInvalidRect {
		t.Fatalf("nil lo err = %v", err)
	}
}

// TestDefensiveCopies ensures mutating caller big.Ints after New does not
// affect the validated array.
func TestDefensiveCopies(t *testing.T) {
	dim := bi(4)
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(4),
		VirtualSel:  sel(axis(0, 1, 2, 1)),
		SourceSel:   sel(axis(0, 1, 2, 1)),
	}}
	va, err := New([]*big.Int{dim}, 0, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	dim.SetInt64(1)
	mappings[0].VirtualSel.Axes[0].Start.SetInt64(99)
	if va.shape[0].Int64() != 4 {
		t.Fatalf("expected internal shape unaffected, got %d", va.shape[0])
	}
	h := newHost()
	got, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect([]int64{0}, []int64{4}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if got.Points[0].MappingIndex != 0 {
		t.Fatalf("mutation leaked into validated selection: %+v", got.Points[0])
	}
}

// TestMaxRankShape exercises the supported rank boundary end to end.
func TestMaxRankShape(t *testing.T) {
	dims := make([]int64, 8)
	for d := range dims {
		dims[d] = 2
	}
	axes := make([]AxisSel, 8)
	for d := range axes {
		axes[d] = axis(0, 1, 2, 1)
	}
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(dims...),
		VirtualSel:  Selection{Axes: axes},
		SourceSel:   Selection{Axes: axes},
	}}
	h := newHost()
	h.add("s", FOrder, dims...)
	va, err := New(shape(dims...), 0, mappings, ordersFor(FOrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	lo := make([]int64, 8)
	got, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect(lo, dims), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if len(got.Values) != 256 {
		t.Fatalf("values = %d, want 256", len(got.Values))
	}
}

// silence unused import guard for big helpers shared across test files.
var _ = big.NewInt
