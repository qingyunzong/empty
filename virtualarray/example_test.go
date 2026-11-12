package virtualarray_test

import (
	"context"
	"fmt"
	"math/big"

	"example.org/dataeng/q0287/virtualarray"
)

// ExampleVirtualArray shows a data-access host wiring mapping metadata, an
// availability snapshot and a batched read callback into one rectangular
// virtual read, including fill provenance.
func ExampleVirtualArray() {
	// A 1-D virtual array of length 6 assembled from two 1-D sources. The
	// second mapping overlaps the first and wins where they overlap.
	virtualShape := []*big.Int{big.NewInt(6)}
	mappings := []virtualarray.Mapping{
		{
			SourceName:  "primary",
			SourceShape: []*big.Int{big.NewInt(6)},
			VirtualSel: virtualarray.Selection{Axes: []virtualarray.AxisSel{
				{Start: big.NewInt(0), Stride: big.NewInt(1), Count: big.NewInt(4), Block: big.NewInt(1)},
			}},
			SourceSel: virtualarray.Selection{Axes: []virtualarray.AxisSel{
				{Start: big.NewInt(0), Stride: big.NewInt(1), Count: big.NewInt(4), Block: big.NewInt(1)},
			}},
		},
		{
			SourceName:  "override",
			SourceShape: []*big.Int{big.NewInt(2)},
			VirtualSel: virtualarray.Selection{Axes: []virtualarray.AxisSel{
				{Start: big.NewInt(3), Stride: big.NewInt(1), Count: big.NewInt(2), Block: big.NewInt(1)},
			}},
			SourceSel: virtualarray.Selection{Axes: []virtualarray.AxisSel{
				{Start: big.NewInt(0), Stride: big.NewInt(1), Count: big.NewInt(2), Block: big.NewInt(1)},
			}},
		},
	}
	orders := map[string]virtualarray.Order{
		"primary":  virtualarray.COrder,
		"override": virtualarray.COrder,
	}

	va, err := virtualarray.New(virtualShape, -1, mappings, orders)
	if err != nil {
		panic(err)
	}

	// Host-side flattened storage. Real hosts would issue I/O here and honor
	// the merged half-open spans. The fill value itself is legal data.
	storage := map[string][]int64{
		"primary":  {10, 11, 12, 13, 14, 15},
		"override": {20, 21},
	}
	read := func(_ context.Context, source string, spans []virtualarray.Span) ([]int64, error) {
		raw := storage[source]
		out := []int64{}
		for _, sp := range spans {
			for idx := new(big.Int).Set(sp.Lo); idx.Cmp(sp.Hi) < 0; idx.Add(idx, big.NewInt(1)) {
				out = append(out, raw[idx.Int64()])
			}
		}
		return out, nil
	}

	// Immutable snapshot for this read: the override source is offline, so
	// its points must be filled without falling back to "primary".
	snap := virtualarray.Snapshot{"primary": true}

	rect := virtualarray.Rect{
		Lo: []*big.Int{big.NewInt(0)},
		Hi: []*big.Int{big.NewInt(6)},
	}
	result, err := va.ReadRect(context.Background(), snap, rect, big.NewInt(1000), read)
	if err != nil {
		panic(err)
	}

	for i, p := range result.Points {
		switch {
		case p.Filled:
			fmt.Printf("%d: fill (%s)\n", i, p.FillReason)
		default:
			fmt.Printf("%d: %d via %s\n", i, result.Values[i], p.SourceName)
		}
	}

	// Output:
	// 0: 10 via primary
	// 1: 11 via primary
	// 2: 12 via primary
	// 3: fill (source-unavailable)
	// 4: fill (source-unavailable)
	// 5: fill (no-mapping)
}
