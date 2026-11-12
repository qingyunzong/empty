package virtualarray

import (
	"context"
	"math/big"
	"sort"
)

// maxSliceLen bounds result slices that must be addressable on this
// platform. Arbitrary-precision metadata above the limit is still accepted
// by New; only materializing an oversized read is refused.
const maxSliceLen = 1 << 30

// readRequest records one output point that must be fetched from a source.
type readRequest struct {
	outIndex    int
	source      string
	linear      *big.Int
	sourceCoord []*big.Int
}

type sourceBatch struct {
	linears []*big.Int
}

// validateRect checks bounds and returns the exact number of points in the
// request without enumerating them.
func (va *VirtualArray) validateRect(rect Rect) (*big.Int, error) {
	if len(rect.Lo) != len(va.shape) || len(rect.Hi) != len(va.shape) {
		return nil, ErrInvalidRect
	}
	count := big.NewInt(1)
	for d := range va.shape {
		lo, hi := rect.Lo[d], rect.Hi[d]
		if lo == nil || hi == nil || lo.Sign() < 0 {
			return nil, ErrInvalidRect
		}
		if lo.Cmp(hi) > 0 || hi.Cmp(va.shape[d]) > 0 {
			return nil, ErrInvalidRect
		}
		count.Mul(count, new(big.Int).Sub(hi, lo))
	}
	return count, nil
}

// ReadRect performs one rectangular read. snap is the immutable source
// availability snapshot for this read only; read is invoked solely for
// sources present and available in snap. A nil budget means no point-count
// limit; otherwise requests larger than budget are rejected before any
// allocation or source callback.
func (va *VirtualArray) ReadRect(ctx context.Context, snap Snapshot, rect Rect, budget *big.Int, read ReadFunc) (*ReadResult, error) {
	nPoints, err := va.validateRect(rect)
	if err != nil {
		return nil, err
	}
	if budget != nil && nPoints.Cmp(budget) > 0 {
		return nil, ErrBudgetExceeded
	}
	// Refuse slices that cannot be addressed on this platform, even though
	// the metadata arithmetic above stays arbitrary precision.
	if !nPoints.IsInt64() || nPoints.Int64() > int64(maxSliceLen) {
		return nil, ErrBudgetExceeded
	}

	rank := len(va.shape)

	// Empty rectangle: return empty slices and make no source callback.
	if nPoints.Sign() == 0 {
		return &ReadResult{Values: []int64{}, Points: []Point{}}, nil
	}

	n := int(nPoints.Int64())
	result := &ReadResult{
		Values: make([]int64, n),
		Points: make([]Point, n),
	}

	batches := map[string]*sourceBatch{}
	var requests []readRequest

	vcoord := make([]*big.Int, rank)

	// Rect axis lengths and suffix products for C-order unranking.
	rectSuffix := make([]*big.Int, rank)
	suffix := big.NewInt(1)
	for d := rank - 1; d >= 0; d-- {
		rectSuffix[d] = new(big.Int).Set(suffix)
		length := new(big.Int).Sub(rect.Hi[d], rect.Lo[d])
		suffix = new(big.Int).Mul(suffix, length)
	}

	for out := 0; out < n; out++ {
		ordinal := big.NewInt(int64(out))
		rem := new(big.Int).Set(ordinal)
		for d := 0; d < rank; d++ {
			local := new(big.Int).Quo(rem, rectSuffix[d])
			rem.Rem(rem, rectSuffix[d])
			vcoord[d] = new(big.Int).Add(rect.Lo[d], local)
		}

		win := va.findMapping(vcoord)
		point := Point{
			MappingIndex: -1,
			VirtualCoord: cloneCoords(vcoord),
		}

		if win == nil {
			point.Filled = true
			point.FillReason = NoMapping
			result.Values[out] = va.fill
			result.Points[out] = point
			continue
		}

		point.MappingIndex = win.index
		point.SourceName = win.sourceName

		if !snap[win.sourceName] {
			// Winning source unavailable: fill and never fall back to an
			// earlier mapping.
			point.Filled = true
			point.FillReason = SourceUnavailable
			result.Values[out] = va.fill
			result.Points[out] = point
			continue
		}

		srcOrdinal := win.virtual.rankOf(vcoord)
		scoord := make([]*big.Int, len(win.source.axes))
		win.source.unrank(srcOrdinal, scoord)
		lin := linearIndex(scoord, win.sourceStrides)

		batch, ok := batches[win.sourceName]
		if !ok {
			batch = &sourceBatch{}
			batches[win.sourceName] = batch
		}
		batch.linears = append(batch.linears, lin)
		requests = append(requests, readRequest{
			outIndex:    out,
			source:      win.sourceName,
			linear:      lin,
			sourceCoord: scoord,
		})
		result.Points[out] = point
	}

	valuesBySource, err := va.readBatches(ctx, snap, read, batches)
	if err != nil {
		return nil, err
	}

	for _, req := range requests {
		val, ok := valuesBySource[req.source][req.linear.String()]
		if !ok {
			// Internal consistency guard: every requested position was read.
			return nil, ErrSourceRead
		}
		result.Values[req.outIndex] = val
		point := result.Points[req.outIndex]
		point.SourceCoord = req.sourceCoord
		result.Points[req.outIndex] = point
	}

	return result, nil
}

// findMapping returns the last mapping whose virtual selection contains the
// coordinate, or nil. Mappings are scanned in reverse so later mappings
// shadow earlier ones.
func (va *VirtualArray) findMapping(coord []*big.Int) *preparedMapping {
	for k := len(va.mappings) - 1; k >= 0; k-- {
		m := va.mappings[k]
		if m.virtual.contains(coord) {
			return m
		}
	}
	return nil
}

// readBatches deduplicates each source's linear positions, merges adjacent
// positions into half-open spans, invokes the host callback once per source
// and returns values keyed by decimal linear index. A callback failure or a
// short batch fails the entire read.
func (va *VirtualArray) readBatches(ctx context.Context, snap Snapshot, read ReadFunc, batches map[string]*sourceBatch) (map[string]map[string]int64, error) {
	names := make([]string, 0, len(batches))
	for name := range batches {
		names = append(names, name)
	}
	sort.Strings(names)

	valuesBySource := make(map[string]map[string]int64, len(names))

	for _, name := range names {
		if !snap[name] {
			// Defensive: unavailable sources never enter batches.
			continue
		}
		uniq := dedupeAndSort(batches[name].linears)
		spans := mergeAdjacent(uniq)

		if err := ctx.Err(); err != nil {
			return nil, err
		}
		values, err := read(ctx, name, spans)
		if err != nil {
			return nil, err
		}

		want := big.NewInt(0)
		for _, sp := range spans {
			want.Add(want, new(big.Int).Sub(sp.Hi, sp.Lo))
		}
		if !want.IsInt64() || int64(len(values)) != want.Int64() {
			return nil, ErrSourceRead
		}

		keyed := make(map[string]int64, len(uniq))
		cursor := 0
		for _, sp := range spans {
			idx := new(big.Int).Set(sp.Lo)
			for idx.Cmp(sp.Hi) < 0 {
				keyed[idx.String()] = values[cursor]
				cursor++
				idx.Add(idx, big.NewInt(1))
			}
		}
		if cursor != len(values) {
			return nil, ErrSourceRead
		}
		valuesBySource[name] = keyed
	}

	return valuesBySource, nil
}

// dedupeAndSort returns the distinct linear positions in increasing order.
func dedupeAndSort(linears []*big.Int) []*big.Int {
	seen := make(map[string]*big.Int, len(linears))
	for _, lin := range linears {
		key := lin.String()
		if _, ok := seen[key]; !ok {
			seen[key] = new(big.Int).Set(lin)
		}
	}
	out := make([]*big.Int, 0, len(seen))
	for _, lin := range seen {
		out = append(out, lin)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Cmp(out[j]) < 0
	})
	return out
}

// mergeAdjacent turns sorted distinct positions into the smallest set of
// half-open spans by coalescing positions that differ by exactly one.
func mergeAdjacent(positions []*big.Int) []Span {
	if len(positions) == 0 {
		return nil
	}
	spans := make([]Span, 0, len(positions))
	lo := new(big.Int).Set(positions[0])
	hi := new(big.Int).Add(positions[0], big.NewInt(1))
	for i := 1; i < len(positions); i++ {
		if positions[i].Cmp(hi) == 0 {
			hi.Add(hi, big.NewInt(1))
			continue
		}
		spans = append(spans, Span{Lo: lo, Hi: hi})
		lo = new(big.Int).Set(positions[i])
		hi = new(big.Int).Add(positions[i], big.NewInt(1))
	}
	spans = append(spans, Span{Lo: lo, Hi: hi})
	return spans
}
