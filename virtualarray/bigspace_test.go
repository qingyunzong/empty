package virtualarray

import (
	"context"
	"math/big"
	"testing"
)

// TestHugeSpaceSmallRequest builds dimensions far beyond 2^64 and reads a
// tiny region. The selection must be resolved with exact big.Int arithmetic
// and never expanded or allocated by total size.
func TestHugeSpaceSmallRequest(t *testing.T) {
	// Dimension lengths: 2^80 and 2^70; request starts beyond uint64.
	huge0 := new(big.Int).Lsh(big.NewInt(1), 80)
	huge1 := new(big.Int).Lsh(big.NewInt(1), 70)
	vShape := []*big.Int{huge0, huge1}

	start0 := new(big.Int).Lsh(big.NewInt(1), 66) // > 2^64
	start1 := new(big.Int).Lsh(big.NewInt(1), 65)
	mappings := []Mapping{{
		SourceName:  "big",
		SourceShape: []*big.Int{huge0, huge1},
		VirtualSel: Selection{Axes: []AxisSel{
			{Start: start0, Stride: bi(3), Count: bi(2), Block: bi(1)},
			{Start: start1, Stride: bi(2), Count: bi(1), Block: bi(2)},
		}},
		SourceSel: Selection{Axes: []AxisSel{
			{Start: bi(0), Stride: bi(1), Count: bi(2), Block: bi(1)},
			{Start: bi(0), Stride: bi(2), Count: bi(2), Block: bi(1)},
		}},
	}}

	h := newHost()
	h.sources["big"] = hostSource{order: COrder, shape: []*big.Int{huge0, huge1}}
	va, err := New(vShape, -7, mappings, ordersFor(COrder, "big"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Request a 2x2 box that overlaps the selection's first axis points.
	lo := []*big.Int{new(big.Int).Set(start0), new(big.Int).Set(start1)}
	hi := []*big.Int{new(big.Int).Add(start0, bi(2)), new(big.Int).Add(start1, bi(2))}
	r := Rect{Lo: lo, Hi: hi}

	before := h.readCalls
	got, err := va.ReadRect(context.Background(), h.snapshot("big"), r, bi(4), h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if h.readCalls != before+1 {
		t.Fatalf("expected one source read, got %d", h.readCalls-before)
	}
	if len(got.Values) != 4 {
		t.Fatalf("values len = %d, want 4", len(got.Values))
	}

	// Membership expectation: virtual selection covers first-axis start0 and
	// start0+3 (block 1), second-axis start1,start1+1. The box's first axis
	// is [start0, start0+2), so only start0 matches; all 4 points on the
	// second axis pair are sourced at source coords (0,0),(0,1).
	wantSourceCoord := [][]int64{{0, 0}, {0, 2}}
	wantLinear := []int64{0, 2}
	for i, p := range got.Points {
		if i < 2 {
			if p.Filled {
				t.Fatalf("point %d should be sourced", i)
			}
			if p.MappingIndex != 0 || p.SourceName != "big" {
				t.Fatalf("point %d provenance wrong: %+v", i, p)
			}
			if len(p.SourceCoord) != 2 ||
				p.SourceCoord[0].Int64() != wantSourceCoord[i][0] ||
				p.SourceCoord[1].Int64() != wantSourceCoord[i][1] {
				t.Fatalf("point %d source coord = %v, want %v", i, p.SourceCoord, wantSourceCoord[i])
			}
			if got.Values[i] != sourceValue(bi(wantLinear[i])) {
				t.Fatalf("point %d value = %d, want %d", i, got.Values[i], sourceValue(bi(wantLinear[i])))
			}
		} else {
			if !p.Filled || p.FillReason != NoMapping {
				t.Fatalf("point %d should be no-mapping fill: %+v", i, p)
			}
		}
	}

	// Budget rejection happens before any callback or oversized allocation.
	h.readCalls = 0
	if _, err := va.ReadRect(context.Background(), h.snapshot("big"), r, bi(3), h.read); err != ErrBudgetExceeded {
		t.Fatalf("budget err = %v, want ErrBudgetExceeded", err)
	}
	if h.readCalls != 0 {
		t.Fatalf("budget rejection must not call sources, calls=%d", h.readCalls)
	}
}

// TestUint64Metadata verifies metadata at the uint64 boundary stays exact.
func TestUint64Metadata(t *testing.T) {
	maxU64 := new(big.Int).SetUint64(^uint64(0))
	dim := new(big.Int).Add(maxU64, big.NewInt(2)) // 2^64 + 1
	last := new(big.Int).Sub(dim, big.NewInt(1))   // 2^64
	mappings := []Mapping{{
		SourceName:  "edge",
		SourceShape: []*big.Int{dim},
		VirtualSel: Selection{Axes: []AxisSel{
			{Start: last, Stride: bi(1), Count: bi(1), Block: bi(1)},
		}},
		SourceSel: Selection{Axes: []AxisSel{
			{Start: bi(0), Stride: bi(1), Count: bi(1), Block: bi(1)},
		}},
	}}
	h := newHost()
	h.sources["edge"] = hostSource{order: COrder, shape: []*big.Int{dim}}
	va, err := New([]*big.Int{dim}, 0, mappings, ordersFor(COrder, "edge"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	got, err := va.ReadRect(context.Background(), h.snapshot("edge"),
		Rect{Lo: []*big.Int{last}, Hi: []*big.Int{dim}}, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if len(got.Values) != 1 || got.Values[0] != sourceValue(bi(0)) {
		t.Fatalf("edge read wrong: %v", got.Values)
	}
	if got.Points[0].VirtualCoord[0].Cmp(last) != 0 {
		t.Fatalf("virtual coord = %s, want %s", got.Points[0].VirtualCoord[0], last)
	}
}

// TestEmptyRectangle confirms an empty box returns empty results and never
// touches sources.
func TestEmptyRectangle(t *testing.T) {
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(2),
		VirtualSel:  sel(axis(0, 1, 2, 1)),
		SourceSel:   sel(axis(0, 1, 2, 1)),
	}}
	h := newHost()
	h.add("s", COrder, 2)
	va, err := New(shape(2), 0, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got, err := va.ReadRect(context.Background(), Snapshot{},
		rect([]int64{1}, []int64{1}), bi(10), h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if len(got.Values) != 0 || len(got.Points) != 0 || h.readCalls != 0 {
		t.Fatalf("empty read must be empty and callback-free")
	}
}
