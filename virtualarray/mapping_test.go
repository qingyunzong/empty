package virtualarray

import (
	"context"
	"testing"
)

// TestFOrderStridedSelection checks Fortran flattening with a strided,
// block>1 selection against the fully-expanded reference.
func TestFOrderStridedSelection(t *testing.T) {
	vShape := shape(3, 4)
	mappings := []Mapping{{
		SourceName:  "f",
		SourceShape: shape(3, 4),
		VirtualSel: sel(
			axis(0, 1, 2, 1), // rows 0,1
			axis(1, 2, 1, 2), // cols 2,3
		),
		SourceSel: sel(
			axis(0, 1, 2, 1),
			axis(1, 2, 1, 2),
		),
	}}
	h := newHost()
	h.add("f", FOrder, 3, 4)
	va, err := New(vShape, 0, mappings, ordersFor(FOrder, "f"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := rect([]int64{0, 0}, []int64{3, 4})
	got, err := va.ReadRect(context.Background(), h.snapshot("f"), r, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	refModel := buildReference([]int64{3, 4}, 0, mappings, ordersFor(FOrder, "f"))
	ref := refModel.read(r, h.snapshot("f"), map[string][]int64{"f": {3, 4}})
	assertAgainstReference(t, got, ref)

	// Fortran index of (row,col) is row + col*3; (0,2) -> 6, (1,3) -> 10.
	wantByCoord := map[string]int64{"0,2": 6, "1,3": 10}
	for i, p := range got.Points {
		if p.Filled {
			continue
		}
		key := p.SourceCoord[0].String() + "," + p.SourceCoord[1].String()
		if wantLin, ok := wantByCoord[key]; ok && got.Values[i] != sourceValue(bi(wantLin)) {
			t.Fatalf("F value at %s = %d, want linear %d", key, got.Values[i], wantLin)
		}
	}
}

// TestCrossRankZipBlockOrder covers a rank-3 virtual selection with block>1
// and stride>block mapped onto a rank-2 source, checking block-internal
// ordering and point-wise zipping.
func TestCrossRankZipBlockOrder(t *testing.T) {
	vShape := shape(4, 6, 8)
	mappings := []Mapping{{
		SourceName:  "src",
		SourceShape: shape(2, 8),
		VirtualSel: sel(
			axis(0, 2, 2, 1), // i = 0,2
			axis(1, 2, 2, 2), // j = 1,2 and 3,4 (stride==block)
			axis(2, 2, 1, 2), // k = 2,3
		),
		SourceSel: sel(
			axis(0, 1, 2, 1), // a = 0,1
			axis(0, 1, 8, 1), // b = 0..7
		),
	}}
	h := newHost()
	h.add("src", COrder, 2, 8)
	va, err := New(vShape, -999, mappings, ordersFor(COrder, "src"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	r := rect([]int64{0, 0, 0}, []int64{4, 6, 8})
	got, err := va.ReadRect(context.Background(), h.snapshot("src"), r, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}

	refModel := buildReference([]int64{4, 6, 8}, -999, mappings, ordersFor(COrder, "src"))
	ref := refModel.read(r, h.snapshot("src"), map[string][]int64{"src": {2, 8}})
	assertAgainstReference(t, got, ref)

	// Exactly 16 virtual points selected out of 192; the rest are fills.
	filled := 0
	for _, p := range got.Points {
		if p.Filled {
			filled++
		}
	}
	if filled != 192-16 {
		t.Fatalf("filled count = %d, want %d", filled, 192-16)
	}
}

// TestCAndFSourceLayout uses identical selections against C and Fortran
// sources and expects distinct flattened indices/values.
func TestCAndFSourceLayout(t *testing.T) {
	vShape := shape(2, 3)
	mappings := []Mapping{
		{
			SourceName:  "cSrc",
			SourceShape: shape(2, 3),
			VirtualSel:  sel(axis(0, 1, 1, 1), axis(0, 1, 3, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1), axis(0, 1, 3, 1)),
		},
		{
			SourceName:  "fSrc",
			SourceShape: shape(2, 3),
			VirtualSel:  sel(axis(1, 1, 1, 1), axis(0, 1, 3, 1)),
			SourceSel:   sel(axis(1, 1, 1, 1), axis(0, 1, 3, 1)),
		},
	}
	h := newHost()
	h.add("cSrc", COrder, 2, 3)
	h.add("fSrc", FOrder, 2, 3)
	orders := map[string]Order{"cSrc": COrder, "fSrc": FOrder}

	va, err := New(vShape, 0, mappings, orders)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := rect([]int64{0, 0}, []int64{2, 3})
	got, err := va.ReadRect(context.Background(), h.snapshot("cSrc", "fSrc"), r, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}

	refModel := buildReference([]int64{2, 3}, 0, mappings, orders)
	ref := refModel.read(r, h.snapshot("cSrc", "fSrc"),
		map[string][]int64{"cSrc": {2, 3}, "fSrc": {2, 3}})
	assertAgainstReference(t, got, ref)

	// Explicit layout difference at coordinate (0,2): C index 2, F index 4.
	cLin := refLinear([]int64{0, 2}, []int64{2, 3}, COrder)
	fLin := refLinear([]int64{0, 2}, []int64{2, 3}, FOrder)
	if cLin != 2 || fLin != 4 {
		t.Fatalf("layout indices C=%d F=%d, want 2 and 4", cLin, fLin)
	}
	if got.Values[2] != sourceValue(bi(2)) {
		t.Fatalf("C value mismatch at index 2")
	}
}
